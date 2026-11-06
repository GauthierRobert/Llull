/**
 * The whole analysis of a stress model from the current document (07 PST §4): build, solve every load case, code stresses, findings, the input hash.
 * Pure and deterministic; used by `analyze_pipe_stress`, `check_pipe_stress`, `record_pipe_stress_results` and the staleness test of `approve_pipe_stress`.
 */

import { jcsJson } from '@lib/jcs';
import type { CadDocument } from '@core/model/types';
import { sha256Hex } from '@lib/sha256';
import { codeStresses, type CodeStressResult, type StressRow } from './code/codeStress';
import { remediationOf } from './codes';
import { buildStressModel, isBuildFailure, type BuiltModel } from './model/build';
import type { OperatingConditions, StressModel } from './model/schema';
import { SOLVER_VERSION, solveModel, type CaseState } from './solve/run';

export interface Finding {
  readonly code: string;
  readonly severity: 'info' | 'warn' | 'fail';
  readonly ids: readonly string[];
  readonly paths: readonly string[];
  readonly message: string;
  readonly remediation: string;
}

export interface Governing {
  readonly case: string;
  readonly nodeId: string;
  readonly ratio: number;
  readonly rule: string;
}

export interface SupportLoad {
  readonly nodeId: string;
  readonly supportIds: readonly string[];
  readonly case: string;
  readonly forceN: readonly [number, number, number];
  readonly momentNmm: readonly [number, number, number];
}

export interface AnalysisFailure {
  readonly ok: false;
  readonly code: string;
  readonly message: string;
  readonly ids: readonly string[];
  readonly paths: readonly string[];
}

export interface Analysis {
  readonly ok: true;
  readonly built: BuiltModel;
  readonly conditions: OperatingConditions;
  readonly states: readonly CaseState[];
  readonly stress: CodeStressResult;
  readonly findings: readonly Finding[];
  readonly governing: readonly Governing[];
  readonly supportLoads: readonly SupportLoad[];
  readonly status: 'pass' | 'fail' | 'incomplete';
  readonly inputHash: string;
  readonly resultHash: string;
  readonly defaulted: readonly string[];
}

const round = (value: number): number => (Number.isFinite(value) ? Number(value.toPrecision(8)) : value);
const DEFAULT_CODES: Readonly<Record<string, string>> = {
  installTempC: 'PST_INSTALL_TEMP_DEFAULTED',
  cycles: 'PST_CYCLES_DEFAULTED',
  frictionCoefficient: 'PST_FRICTION_DEFAULTED',
  corrosionAllowanceMm: 'PST_CORROSION_DEFAULTED',
};

const finding = (
  code: string,
  severity: Finding['severity'],
  message: string,
  ids: readonly string[] = [],
  paths: readonly string[] = [],
): Finding => ({ code, severity, ids, paths, message, remediation: remediationOf(code) });

/** Hash of everything the analysis reads: the stored model (without its recorded results and approval), the resolved pipes and supports, the thermal material record. */
export function inputHashOf(doc: CadDocument, model: StressModel, built: BuiltModel | null): string {
  const { recorded, approval, ...stored } = model;
  void recorded;
  void approval;
  const thermal = model.conditions?.material.thermal;
  const material =
    thermal !== undefined && 'materialId' in thermal && doc.materials !== undefined && Object.hasOwn(doc.materials, thermal.materialId)
      ? doc.materials[thermal.materialId]
      : null;
  return sha256Hex(
    jcsJson({
      solver: SOLVER_VERSION,
      model: stored,
      pipes: built?.sources.pipes ?? null,
      supports: built?.sources.supports ?? null,
      components: built?.sources.components ?? null,
      branches: built?.sources.branches ?? null,
      material,
    }),
  );
}

/** The input hash of `model` in `doc` without solving (the staleness test); a model that does not build hashes its stored form. */
export function currentInputHash(doc: CadDocument, model: StressModel): string {
  const built = buildStressModel(doc, model);
  return inputHashOf(doc, model, isBuildFailure(built) ? null : built);
}

function lines(rows: readonly StressRow[], type: StressRow['caseType'], limit: number): StressRow[] {
  return rows.filter((row) => row.caseType === type && row.ratio > limit);
}

function findingsOf(
  model: StressModel,
  built: BuiltModel,
  conditions: OperatingConditions,
  states: readonly CaseState[],
  rows: readonly StressRow[],
  warnings: ReadonlyArray<{ code: string; message: string; ids: readonly string[] }>,
): Finding[] {
  const out: Finding[] = [];
  for (const warning of warnings) out.push(finding(warning.code, 'warn', warning.message, warning.ids));
  for (const name of [...model.defaulted.map((entry) => `model.${entry}`), ...conditions.defaulted.map((entry) => `conditions.${entry}`)]) {
    const key = name.split('.')[1] as string;
    const code = DEFAULT_CODES[key];
    if (code !== undefined) out.push(finding(code, 'warn', `${key} is a named default`, [], [name]));
  }
  const overstress: [string, StressRow['caseType'], string][] = [
    ['PST_SUSTAINED_OVERSTRESS', 'SUS', 'sustained stress S_L above the allowable S_h'],
    ['PST_EXPANSION_OVERSTRESS', 'EXP', 'displacement stress range S_E above the allowable S_A'],
    ['PST_OCCASIONAL_OVERSTRESS', 'OCC', 'occasional stress above its allowable'],
    ['PST_HYDROTEST_OVERSTRESS', 'HYD', 'hydrotest stress S_L above the stated hydrotest allowable'],
  ];
  for (const [code, type, text] of overstress) {
    const over = lines(rows, type, 1);
    if (over.length > 0) {
      const worst = over.reduce((a, b) => (b.ratio > a.ratio ? b : a));
      out.push(
        finding(
          code,
          'fail',
          `${text}: ${over.length} station(s), worst ${worst.case} ${worst.node ?? worst.element} ratio ${worst.ratio.toFixed(3)}`,
          [...new Set(over.map((row) => row.node ?? row.element))],
        ),
      );
    }
  }
  const lifted = states.flatMap((state) =>
    (state.type === 'OPE' || state.type === 'SUS' ? state.contacts : [])
      .filter((outcome) => outcome.status === 'lifted')
      .flatMap((outcome) => outcome.contact.sources),
  );
  if (lifted.length > 0)
    out.push(
      finding('PST_SUPPORT_LIFTOFF', 'warn', `${[...new Set(lifted)].length} support(s) lift off in OPE or SUS`, [...new Set(lifted)]),
    );
  const types = new Set(states.map((state) => state.type));
  if (!types.has('SUS') || !types.has('EXP'))
    out.push(
      finding(
        'PST_CASE_INCOMPLETE',
        'warn',
        'the load cases lack a sustained (SUS) or an expansion (EXP) case: the code check is incomplete',
      ),
    );
  void built;
  return out;
}

/**
 * @failure model without conditions -> PST_CONDITIONS_MISSING; a non-finite stress or ratio at any station -> PST_STRESS_NOT_FINITE (never recorded); the build, solve and load case failures of `buildStressModel` / `solveModel`
 */
export function analyzeStressModel(doc: CadDocument, model: StressModel): Analysis | AnalysisFailure {
  const conditions = model.conditions;
  if (conditions === undefined)
    return {
      ok: false,
      code: 'PST_CONDITIONS_MISSING',
      message: `model ${model.id} has no operating conditions`,
      ids: [model.id],
      paths: ['conditions'],
    };
  const built = buildStressModel(doc, model);
  if (isBuildFailure(built)) return built;
  const solved = solveModel(doc, model, built, conditions);
  if (!solved.ok) return solved;
  const stress = codeStresses({ built, conditions, states: solved.states });
  const broken = stress.rows.filter((row) => !Number.isFinite(row.ratio) || !Number.isFinite(row.stressMPa));
  if (broken.length > 0)
    return {
      ok: false,
      code: 'PST_STRESS_NOT_FINITE',
      message: `${broken.length} stress station(s) are not finite (non-physical section, allowable or load): the code check cannot run`,
      ids: [...new Set(broken.map((row) => row.node ?? row.element))],
      paths: ['conditions.material'],
    };
  const findings = findingsOf(model, built, conditions, solved.states, stress.rows, solved.warnings);
  const governing: Governing[] = [];
  for (const state of solved.states) {
    const own = stress.rows.filter((row) => row.case === state.name);
    if (own.length === 0) continue;
    const worst = own.reduce((a, b) => (b.ratio > a.ratio ? b : a));
    governing.push({ case: state.name, nodeId: worst.node ?? worst.element, ratio: round(worst.ratio), rule: worst.rule });
  }
  const holders = new Map<number, Set<string>>();
  for (const anchor of built.restraints.anchors)
    holders.set(anchor.node, new Set([...(holders.get(anchor.node) ?? []), ...anchor.sources]));
  for (const contact of built.restraints.contacts)
    holders.set(contact.node, new Set([...(holders.get(contact.node) ?? []), ...contact.sources]));
  for (const spring of built.springs) holders.set(spring.node, new Set([...(holders.get(spring.node) ?? []), spring.id]));
  const supportLoads: SupportLoad[] = [];
  // an OCC case combined by scalar or srss has no physical reactions (sums of magnitudes): no support loads for it
  for (const state of solved.states.filter((entry) => entry.combination === undefined))
    for (const [node, sources] of [...holders].sort((a, b) => a[0] - b[0])) {
      const at = (offset: number): number => round(state.reactions[node * 6 + offset] as number);
      supportLoads.push({
        nodeId: `N${node + 1}`,
        supportIds: [...sources].sort(),
        case: state.name,
        forceN: [at(0), at(1), at(2)],
        momentNmm: [at(3), at(4), at(5)],
      });
    }
  const status: Analysis['status'] = findings.some((entry) => entry.severity === 'fail')
    ? 'fail'
    : findings.some((entry) => entry.code === 'PST_CASE_INCOMPLETE')
      ? 'incomplete'
      : 'pass';
  const inputHash = inputHashOf(doc, model, built);
  const resultHash = sha256Hex(
    jcsJson({ inputHash, status, governing, supportLoads, findings: findings.map((entry) => [entry.code, entry.severity, entry.ids]) }),
  );
  return {
    ok: true,
    built,
    conditions,
    states: solved.states,
    stress,
    findings,
    governing,
    supportLoads,
    status,
    inputHash,
    resultHash,
    defaulted: [...model.defaulted, ...conditions.defaulted],
  };
}
