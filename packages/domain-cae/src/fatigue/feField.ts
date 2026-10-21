/**
 * FatigueField (PHY-07 TR-FAT-41, RS1 RS-7): the all-node fatigue damage of an FE-driven case. Pure: builds the `llull-compute post fatigue`
 * job (superposed load cases, measure, counting, resolved curve) from a trusted results artifact, encodes the native field as a content-addressed `fe_results` artifact bound to the case input
 * hash (`fatigueInputHash`) and reads it back with every binding checked. The host runs the job; nothing here touches native code.
 */

import type { FatigueCase } from '@core/model/durability';
import type { FeArtifactPort, FeMeshArtifact, FeResultsArtifact } from '@core/model/analysis';
import type { CadDocument } from '@core/model/types';
import { canonicalJson } from '@lib/canonicalJson';
import { sha256Hex } from '@lib/sha256';
import { loadCasesOf } from '../decks/context';
import { stressPerMpa } from '../decks/units';
import { stepOfLoadCase } from '../results/fields';
import { caseOf } from '../shared/access';
import { trustedRecord } from '../shared/trust';
import { damageSetupOf, isEvaluationFailure, type DamageSetup, type Failure } from './evaluate';
import { measureSpecOf, nodeSeries, type MeasureSpec, type Tensor } from './feStress';
import { toMpa } from './lifeMath';
import { countCycles, type CountingMethod, type ResidueRule } from './rainflow';
import { fatigueCaseOf, historyOf } from './store';

const FATIGUE_FIELD_SOLVER = 'llull-compute post fatigue';
/** Values per node: damage per block, cycles counted, largest equivalent amplitude (MPa), flags. */
export const FIELD_COMPONENTS = ['D', 'CYCLES', 'SEQA', 'FLAGS'] as const;
const FIELD_NAME = 'FATIGUE';
export const FLAG_BITS = { static_failure: 1, swt_nonpositive: 2, no_life: 4, extrapolated: 8 } as const;

/** `job.json` of `llull-compute post fatigue` (field names are the Rust `FatigueJob`). */
interface FatigueFieldJob {
  readonly task: 'fatigue';
  readonly nodeCount: number;
  readonly loadCases: number;
  readonly steps: number;
  readonly histories: readonly (readonly number[])[];
  readonly measure: MeasureSpec;
  readonly counting: { readonly method: CountingMethod; readonly residue: ResidueRule; readonly gate: number };
  readonly damage: Record<string, unknown>;
}

export interface FatigueFieldInput {
  readonly fatigueCase: FatigueCase;
  readonly job: FatigueFieldJob;
  /** node-major `nodeCount x loadCases x 6`, MPa. */
  readonly tensors: Float64Array;
  readonly nodeIds: readonly number[];
  /** fatigueInputHash: sha256 of everything the field depends on (results hash, histories, measure, counting, resolved curve). */
  readonly key: string;
  readonly resultsHash: string;
  readonly meshHash: string;
  readonly mesh: FeMeshArtifact;
  readonly damage: DamageSetup;
  /** Mesh nodes without a finite stress tensor in every mapped load case (left out of the field). */
  readonly skippedNodes: number;
}

const failure = (code: string, message: string, ids: readonly string[]): Failure => ({ code, message, ids });
const finiteOrNull = (value: number | undefined): number | null => (value !== undefined && Number.isFinite(value) ? value : null);

/** The damage set-up with every stress in MPa, as the Rust `DamageSetup` reads it. */
function jobDamageOf(damage: DamageSetup): Record<string, unknown> {
  if (damage.method === 'strain_life') {
    const { curve, cyclic, mean, kf } = damage.setup;
    return {
      method: 'strain_life',
      curve: { sigmaF: toMpa(curve.sigmaF), E: toMpa(curve.E), b: curve.b, c: curve.c, epsF: curve.epsF },
      cyclic: { E: cyclic.E, kPrime: cyclic.kPrime, nPrime: cyclic.nPrime },
      mean,
      kf,
    };
  }
  const { curve, mean } = damage.setup;
  const range = curve.conditions.testedLifeRange ?? null;
  const resolved =
    curve.kind === 'sn_basquin'
      ? {
          kind: curve.kind,
          sigmaF: toMpa(curve.sigmaF),
          b: curve.b,
          enduranceAmplitude: curve.enduranceAmplitude === undefined ? null : toMpa(curve.enduranceAmplitude),
          testedLifeRange: range,
        }
      : curve.kind === 'sn_power_law'
        ? { kind: curve.kind, sD: toMpa(curve.sD), k: curve.k, k2: curve.k2 ?? null, nD: curve.nD, testedLifeRange: range }
        : { kind: curve.kind, points: curve.families[0]?.points ?? [] };
  return {
    method: 'stress_life',
    curve: resolved,
    modifierProduct: damage.setup.modifierProduct,
    mean: {
      model: mean.model,
      gamma: finiteOrNull(mean.gamma),
      su: finiteOrNull(mean.su),
      sy: finiteOrNull(mean.sy),
      sigmaF: finiteOrNull(mean.sigmaF),
      compressiveMean: mean.compressiveMean,
    },
    ftu: damage.setup.ftu,
    stressScale: damage.setup.stressScale,
  };
}

/** Load-factor series per mapping entry (value x scale, -0 written as 0) with the 0-based load case each one drives. */
function mappedHistories(
  doc: CadDocument,
  fatigueCase: FatigueCase,
  loadCases: readonly string[],
): { readonly histories: number[][]; readonly loadCaseIndex: number[] } | Failure {
  const histories: number[][] = [];
  const loadCaseIndex: number[] = [];
  for (const entry of fatigueCase.mapping) {
    const history = historyOf(doc, entry.historyId);
    if (history === undefined) return failure('FAT_HISTORY_NOT_FOUND', `no history '${entry.historyId}'`, [entry.historyId]);
    if (history.kind !== 'load_factor')
      return failure(
        'FAT_HISTORY_INVALID',
        `history '${history.id}' is ${history.kind}; an FE case scales load cases by load_factor histories`,
        [history.id],
      );
    if (history.data.form !== 'series')
      return failure('FAT_HISTORY_MISMATCH', `history '${history.id}' is a blocks history; an FE case needs series on one time base`, [
        history.id,
      ]);
    const index = entry.loadCase === undefined ? (loadCases.length === 1 ? 0 : -1) : loadCases.indexOf(entry.loadCase);
    if (index < 0)
      return failure(
        'FAT_CASE_INVALID',
        `mapping entry of history '${history.id}' needs loadCase = one of ${loadCases.join(', ') || '(none)'}`,
        [fatigueCase.id],
      );
    histories.push(
      history.data.values.map((value) => {
        const scaled = value * entry.scale;
        return scaled === 0 ? 0 : scaled;
      }),
    );
    loadCaseIndex.push(index);
  }
  const steps = histories[0]?.length ?? 0;
  if (histories.some((values) => values.length !== steps))
    return failure(
      'FAT_HISTORY_MISMATCH',
      'mapped histories have different lengths',
      fatigueCase.mapping.map((m) => m.historyId),
    );
  return { histories, loadCaseIndex };
}

/**
 * The native job of FE fatigue case `caseId` and everything needed to check its result.
 * @failure unknown case -> FAT_CASE_NOT_FOUND; history-only case / bad mapping -> FAT_CASE_INVALID; analysis stale -> FAT_RESULTS_STALE;
 *   unsolved / unverifiable results or no STRESS field -> FAT_RESULTS_MISSING; history / curve problems -> their FAT_* code
 */
export function fatigueFieldInput(
  doc: CadDocument,
  caseId: string,
  artifacts: FeArtifactPort | null | undefined,
): FatigueFieldInput | Failure {
  const fatigueCase = fatigueCaseOf(doc, caseId);
  if (fatigueCase === undefined) return failure('FAT_CASE_NOT_FOUND', `no fatigue case '${caseId}'`, [caseId]);
  const analysisId = fatigueCase.analysisId;
  const analysisCase = analysisId === undefined ? undefined : caseOf(doc, analysisId);
  if (analysisId === undefined || analysisCase === undefined)
    return failure('FAT_CASE_INVALID', `fatigue case '${caseId}' has no FE analysis (analysisId)`, [caseId]);
  const trust = trustedRecord(doc, analysisCase, artifacts);
  if (trust.state === 'stale') return failure('FAT_RESULTS_STALE', `the results of analysis '${analysisId}' are stale`, [analysisId]);
  const results = trust.resultsArtifact;
  const mesh = trust.meshArtifact;
  if (trust.state !== 'solved' || results === null || mesh === null || analysisCase.results === undefined)
    return failure(
      'FAT_RESULTS_MISSING',
      `analysis '${analysisId}' has no verified results on this machine${trust.problem === null ? '' : `: ${trust.problem.message}`}`,
      [analysisId],
    );
  const damage = damageSetupOf(doc, fatigueCase);
  if (isEvaluationFailure(damage)) return damage;
  const loadCases = loadCasesOf(analysisCase).map((entry) => entry.name);
  const mapped = mappedHistories(doc, fatigueCase, loadCases);
  if (isEvaluationFailure(mapped)) return mapped;
  const fields = mapped.loadCaseIndex.map((index) => stepOfLoadCase(results, index, analysisCase)?.fields['STRESS']);
  const missing = fields.findIndex((field) => field === undefined);
  if (missing >= 0)
    return failure(
      'FAT_RESULTS_MISSING',
      `the results have no STRESS field for load case '${loadCases[mapped.loadCaseIndex[missing] ?? 0]}'`,
      [analysisId],
    );
  const perMpa = stressPerMpa(analysisCase.unitSystem);
  const nodeIds: number[] = [];
  const values: number[] = [];
  for (const [nodeId] of mesh.nodes) {
    const tensors = fields.map((field) => field?.values[String(nodeId)]);
    if (tensors.some((tensor) => tensor === undefined || tensor.length < 6 || tensor.slice(0, 6).some((v) => !Number.isFinite(v))))
      continue;
    nodeIds.push(nodeId);
    for (const tensor of tensors) for (let c = 0; c < 6; c += 1) values.push((tensor?.[c] ?? 0) / perMpa);
  }
  if (nodeIds.length === 0)
    return failure('FAT_RESULTS_MISSING', 'no mesh node has a finite stress tensor in every mapped load case', [analysisId]);
  const { method, residue, gate } = fatigueCase.counting;
  const job: FatigueFieldJob = {
    task: 'fatigue',
    nodeCount: nodeIds.length,
    loadCases: mapped.histories.length,
    steps: mapped.histories[0]?.length ?? 0,
    histories: mapped.histories,
    measure: measureSpecOf(fatigueCase.measure),
    counting: { method, residue, gate: gate ?? 0 },
    damage: jobDamageOf(damage),
  };
  const resultsHash = analysisCase.results.resultsHash;
  const key = sha256Hex(canonicalJson({ format: 'llull/fatigue-field/1', resultsHash, meshHash: results.meshHash, nodeIds, job }));
  return {
    fatigueCase,
    job,
    tensors: Float64Array.from(values),
    nodeIds,
    key,
    resultsHash,
    meshHash: results.meshHash,
    mesh,
    damage,
    skippedNodes: mesh.nodes.length - nodeIds.length,
  };
}

/** Tensors of node `index` (one per load case). */
function tensorsOfNode(input: FatigueFieldInput, index: number): Tensor[] {
  const perNode = input.job.loadCases * 6;
  return Array.from({ length: input.job.loadCases }, (_, k) =>
    Array.from(input.tensors.subarray(index * perNode + k * 6, index * perNode + k * 6 + 6)),
  );
}

/** Scalar stress history of node `index`. */
const seriesOfNode = (input: FatigueFieldInput, index: number): number[] =>
  nodeSeries(tensorsOfNode(input, index), input.job.histories, input.job.measure);

/** Cycles of node `index` under the case counting rule. */
export function cyclesOfNode(input: FatigueFieldInput, index: number): ReturnType<typeof countCycles> {
  const { method, residue, gate } = input.job.counting;
  return countCycles(seriesOfNode(input, index), method, residue, gate);
}

/**
 * The FatigueField artifact of a computed field (`kind: 'fe_results'`, bound to the case input hash and the results mesh).
 * @failure a non-finite value or a field of the wrong size -> a message
 */
export function fatigueFieldArtifact(input: FatigueFieldInput, field: Float64Array, solverVersion: string): FeResultsArtifact | string {
  const width = FIELD_COMPONENTS.length;
  if (field.length !== input.nodeIds.length * width)
    return `the field holds ${field.length} values, expected ${input.nodeIds.length * width}`;
  const bad = field.findIndex((value) => !Number.isFinite(value));
  if (bad >= 0) return `the field value of node ${input.nodeIds[Math.floor(bad / width)]} is not finite`;
  const values: Record<string, number[]> = {};
  input.nodeIds.forEach((nodeId, index) => (values[String(nodeId)] = Array.from(field.subarray(index * width, index * width + width))));
  return {
    kind: 'fe_results',
    meshHash: input.meshHash,
    inputHash: input.key,
    solver: FATIGUE_FIELD_SOLVER,
    solverVersion,
    steps: [{ step: 1, time: 0, fields: { [FIELD_NAME]: { components: [...FIELD_COMPONENTS], values } } }],
  };
}

/**
 * The current FatigueField of `input` from the artifact port (looked up by its input hash), aligned with `input.nodeIds`.
 * @failure absent -> FAT_RESULTS_MISSING; bound to another input / mesh, other solver or missing nodes -> FAT_FIELD_INVALID
 */
export function readFatigueField(artifacts: FeArtifactPort | null | undefined, input: FatigueFieldInput): Float64Array | Failure {
  const ids = [input.fatigueCase.id];
  const found = artifacts?.get(input.key) ?? null;
  if (found === null)
    return failure(
      'FAT_RESULTS_MISSING',
      `no current fatigue field for case '${input.fatigueCase.id}' (run fatigue_field caseId=${input.fatigueCase.id})`,
      ids,
    );
  if (
    found.kind !== 'fe_results' ||
    found.inputHash !== input.key ||
    found.meshHash !== input.meshHash ||
    found.solver !== FATIGUE_FIELD_SOLVER
  )
    return failure('FAT_FIELD_INVALID', 'the stored fatigue field is not bound to this case input and mesh', ids);
  const field = found.steps[0]?.fields[FIELD_NAME];
  const width = FIELD_COMPONENTS.length;
  const out = new Float64Array(input.nodeIds.length * width);
  for (const [index, nodeId] of input.nodeIds.entries()) {
    const row = field?.values[String(nodeId)];
    if (row === undefined || row.length !== width || row.some((value) => !Number.isFinite(value)))
      return failure('FAT_FIELD_INVALID', `the stored fatigue field has no valid row for node ${nodeId}`, ids);
    out.set(row, index * width);
  }
  return out;
}
