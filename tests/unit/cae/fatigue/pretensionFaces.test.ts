/**
 * PHY-06 M3b: FE fatigue at the nodes of a bolt pretension cut. The solver writes such a node twice (the low-side mesh node and a high-side duplicate): both
 * faces go to the native job as nodes of their own and, after the run, each cut node keeps the row of the face that did MORE DAMAGE (a larger range is not
 * the worse face once a mean-stress rule applies). Oracle: sxx(t) = a h(t) + m with h = +1, -1, ... (cycle amplitude a, mean m), Basquin curve, Ftu 900 MPa.
 * Face A: a = 50, m = 0 (range 100). Face B: a = 45, m = 200 (range 90). SWT: sqrt(sigma_max sigma_a) = 50 vs sqrt(245 x 45) = 105; Goodman:
 * 50 vs 45 / (1 - 200 / 900) = 57.9. Face B is worse under both although face A has the larger range.
 */
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { FeResultsArtifact } from '@core/model/analysis';
import type { CadDocument } from '@core/model/types';
import { copiesOf, pretensionResultMap } from '@cae/contact/pretensionDeck';
import { isEvaluationFailure } from '@cae/fatigue/evaluate';
import {
  fatigueFieldArtifact,
  fatigueFieldInput,
  FIELD_COMPONENTS,
  FLAG_BITS,
  governingJobIndex,
  readFatigueField,
  type FatigueFieldInput,
} from '@cae/fatigue/feField';
import { analysisInputHash } from '@cae/hash/inputHash';
import { meshSummary, resultsSummary } from '@cae/results/summary';
import { caseOf, withCase } from '@cae/shared/access';
import { fatigueFieldReference } from '../../../helpers/fatigueFieldOracle';
import { must } from '../contact/support';
import { feFatigue, type FeFatigue } from './feFixtures';

const SOURCE = { citation: 'synthetic test fixture', locator: 'tests/unit/cae/fatigue/pretensionFaces' };
const STEPS = 40;
const alternating = Array.from({ length: STEPS }, (_, index) => (index % 2 === 0 ? 1 : -1));
const ones = Array.from({ length: STEPS }, () => 1);

interface Faces {
  /** [LC1 sxx, LC2 sxx] of the low side (the mesh node) and of the high side (the copy). */
  readonly low: readonly [number, number];
  readonly high: readonly [number, number];
}

interface Built {
  readonly f: FeFatigue;
  readonly doc: CadDocument;
  readonly caseId: string;
  readonly input: FatigueFieldInput;
  readonly copies: ReadonlyMap<number, readonly number[]>;
}

/** The fatigue fixture with a bolt cut at x = 1, a case of two histories (alternating on LC1, constant on LC2) and the given sxx on the two faces of every cut node. */
function build(
  meanStress: string,
  faces: Faces,
  mutate: (values: Record<string, readonly number[]>, step: number, copies: ReadonlyMap<number, readonly number[]>) => void = () =>
    undefined,
): Built {
  const f = feFatigue();
  const entityId = f.mesh.blocks[0]?.entityId ?? '';
  const analysis = caseOf(f.doc, f.analysisId);
  if (analysis === undefined) throw new Error('no analysis');
  const bolt = {
    id: 'bp-1.1',
    name: 't',
    entityId,
    section: { point: [1, 0.5, 0.5], normal: [1, 0, 0] },
    preload: { kind: 'force', value: 1 },
    preloadStepId: 's',
    lockAfter: true,
  } as const;
  let doc = withCase(f.doc, { ...analysis, pretension: { bolts: { [bolt.id]: bolt }, order: [bolt.id] } });
  const history = (name: string, values: number[]): string => {
    const made = must(doc, 'define_load_history', {
      name,
      kind: 'load_factor',
      unit: '-',
      data: { form: 'series', values },
      source: SOURCE,
    });
    doc = made.doc;
    return made.affected[0] ?? '';
  };
  const [alt, one] = [history('alt', alternating), history('one', ones)];
  const created = must(doc, 'create_fatigue_case', {
    name: 'faces',
    method: 'stress_life',
    analysisId: f.analysisId,
    mapping: [
      { loadCase: 'LC1', historyId: alt, scale: 1 },
      { loadCase: 'LC2', historyId: one, scale: 1 },
    ],
    material: { recordId: 'steel', modelId: 'sn1' },
    meanStress,
    measure: { component: 'sxx' },
    locations: { mode: 'hotspots', count: 3 },
    requiredLife: { value: 1000, unit: 'blocks' },
    factors: { scatter: { value: 3, source: 'test' }, marginalBand: 0.5 },
  });
  doc = created.doc;
  const plan = pretensionResultMap(doc, f.analysisId, f.mesh);
  if (plan === null) throw new Error('the cut does not hold on the fatigue grid');
  const copies = copiesOf(plan);
  const steps = f.results.steps.map((step, index) => {
    const values: Record<string, readonly number[]> = Object.fromEntries(f.mesh.nodes.map(([id]) => [String(id), [0, 0, 0, 0, 0, 0]]));
    for (const [node, list] of copies) {
      values[String(node)] = [faces.low[index] ?? 0, 0, 0, 0, 0, 0];
      for (const copy of list) values[String(copy)] = [faces.high[index] ?? 0, 0, 0, 0, 0, 0];
    }
    mutate(values, index, copies);
    return { ...step, fields: { ...step.fields, STRESS: { components: step.fields['STRESS']?.components ?? [], values } } };
  });
  const results: FeResultsArtifact = { ...f.results, inputHash: analysisInputHash(doc, f.analysisId, 'full'), steps };
  const meshHash = f.store.put(f.mesh);
  const resultsHash = f.store.put(results);
  const meshed = must(doc, 'record_fe_mesh', { analysisId: f.analysisId, summary: meshSummary(f.mesh, meshHash) }, f.ctx);
  doc = must(
    meshed.doc,
    'record_fea_results',
    { analysisId: f.analysisId, summary: resultsSummary(meshed.doc, f.analysisId, f.mesh, results, resultsHash) },
    f.ctx,
  ).doc;
  const caseId = created.affected[0] ?? '';
  const input = fatigueFieldInput(doc, caseId, f.store);
  if (isEvaluationFailure(input)) throw new Error(input.message);
  return { f, doc, caseId, input, copies };
}

/** The folded field as the artifact store returns it, aligned with `input.nodeIds`. */
function foldedField(b: Built): Float64Array {
  const artifact = fatigueFieldArtifact(b.input, fatigueFieldReference(b.input), 'test');
  if (typeof artifact === 'string') throw new Error(artifact);
  b.f.store.alias(b.input.key, b.f.store.put(artifact));
  const field = readFatigueField(b.f.store, b.input);
  if (isEvaluationFailure(field)) throw new Error(field.message);
  return field;
}

const width = FIELD_COMPONENTS.length;
const damageOf = (field: Float64Array, index: number): number => field[index * width] ?? Number.NaN;
const flagsOf = (field: Float64Array, index: number): number => field[index * width + 3] ?? Number.NaN;

describe('FE fatigue at a pretension cut: the face with more damage governs', () => {
  it.each(['swt', 'goodman'])(
    '%s: face B (range 90, mean 200) does more damage than face A (range 100, mean 0), so it governs although A has the larger range',
    (meanStress) => {
      const b = build(meanStress, { low: [50, 0], high: [45, 200] });
      const reference = fatigueFieldReference(b.input);
      const [cutNode = 0] = [...b.copies.keys()];
      const face = b.input.faces.find((entry) => entry.node === cutNode);
      if (face === undefined) throw new Error('no face');
      const lowIndex = b.input.nodeIds.indexOf(cutNode);
      // precondition: the ranges say A, the damages say B (a range selector picks A)
      const tensorsOf = (index: number): number[] => Array.from(b.input.tensors.subarray(index * 12, index * 12 + 12));
      const rangeOf = (index: number): number => {
        const [t1 = 0, , , , , , t2 = 0] = tensorsOf(index);
        const series = alternating.map((h) => t1 * h + t2);
        return Math.max(...series) - Math.min(...series);
      };
      expect(rangeOf(lowIndex)).toBeCloseTo(100, 9);
      expect(rangeOf(face.jobIndex)).toBeCloseTo(90, 9);
      expect(damageOf(reference, face.jobIndex)).toBeGreaterThan(damageOf(reference, lowIndex));
      const field = foldedField(b);
      expect(flagsOf(field, lowIndex) & FLAG_BITS.high_face).toBe(FLAG_BITS.high_face);
      expect(damageOf(field, lowIndex)).toBe(damageOf(reference, face.jobIndex));
      expect(governingJobIndex(b.input, field, lowIndex)).toBe(face.jobIndex);
      // a node that is not on the cut keeps itself
      const other = b.input.nodeIds.findIndex((node) => !b.copies.has(node));
      expect(governingJobIndex(b.input, field, other)).toBe(other);
    },
  );

  it('the low face governs when it does more damage, and on a tie (the high_face flag stays clear)', () => {
    const worseLow = build('swt', { low: [45, 200], high: [50, 0] });
    const [cutNode = 0] = [...worseLow.copies.keys()];
    const field = foldedField(worseLow);
    const index = worseLow.input.nodeIds.indexOf(cutNode);
    expect(flagsOf(field, index) & FLAG_BITS.high_face).toBe(0);
    expect(governingJobIndex(worseLow.input, field, index)).toBe(index);
    const tie = build('goodman', { low: [50, 100], high: [50, 100] });
    const tieField = foldedField(tie);
    expect(flagsOf(tieField, tie.input.nodeIds.indexOf([...tie.copies.keys()][0] ?? 0)) & FLAG_BITS.high_face).toBe(0);
  });

  it('puts the copies in the native job after the mesh nodes (job count = nodes + faces, one tensor block each)', () => {
    const b = build('swt', { low: [50, 0], high: [45, 200] });
    expect(b.input.faces.length).toBe(b.copies.size);
    expect(b.input.job.nodeCount).toBe(b.input.nodeIds.length + b.input.faces.length);
    expect(b.input.tensors.length).toBe(b.input.job.nodeCount * b.input.job.loadCases * 6);
    expect(b.input.faces.map((face) => face.jobIndex)).toEqual(b.input.faces.map((_, index) => b.input.nodeIds.length + index));
  });

  it('a copy without a finite stress is not a candidate (the node keeps itself); a cut node without a finite own stress is left out', () => {
    const noCopy = build('swt', { low: [50, 0], high: [45, 200] }, (values, step, copies) => {
      if (step === 0) for (const list of copies.values()) for (const copy of list) values[String(copy)] = [Number.NaN, 0, 0, 0, 0, 0];
    });
    expect(noCopy.input.faces).toEqual([]);
    expect(noCopy.input.skippedNodes).toBe(0);
    const lost = build('swt', { low: [50, 0], high: [45, 200] }, (values, step, copies) => {
      const [node] = [...copies.keys()];
      if (step === 0 && node !== undefined) values[String(node)] = [Number.NaN, 0, 0, 0, 0, 0];
    });
    expect(lost.input.skippedNodes).toBe(1);
    expect(lost.input.faces.length).toBe(lost.copies.size - 1);
  });

  it('a static failure on the high face outranks any damage of the low face; a field of the wrong size or with a non-finite row is a message', () => {
    const b = build('swt', { low: [50, 0], high: [45, 200] });
    const reference = fatigueFieldReference(b.input);
    const face = b.input.faces[0];
    if (face === undefined) throw new Error('no face');
    const forced = Float64Array.from(reference);
    forced[face.jobIndex * width] = 0;
    forced[face.jobIndex * width + 3] = FLAG_BITS.static_failure;
    forced[b.input.nodeIds.indexOf(face.node) * width] = 1e9;
    const artifact = fatigueFieldArtifact(b.input, forced, 'test');
    if (typeof artifact === 'string') throw new Error(artifact);
    const row = artifact.steps[0]?.fields['FATIGUE']?.values[String(face.node)];
    expect((row?.[3] ?? 0) & FLAG_BITS.high_face).toBe(FLAG_BITS.high_face);
    expect(typeof fatigueFieldArtifact(b.input, reference.subarray(1), 'test')).toBe('string');
    const broken = Float64Array.from(reference);
    broken[3 * width] = Number.NaN;
    expect(fatigueFieldArtifact(b.input, broken, 'test')).toMatch(/not finite/);
  });

  it('compute_fatigue ranks the hot spots on the folded field and its TypeScript reference agrees with the native damage of the governing face', () => {
    const b = build('swt', { low: [50, 0], high: [45, 200] });
    foldedField(b);
    const result = execute(b.doc, 'compute_fatigue', { caseId: b.caseId }, b.f.ctx);
    expect(result.error, result.summary).toBeUndefined();
    expect(result.summary).not.toContain('FAT_NATIVE_MISMATCH');
  });
});

describe('fatigueFieldInput refusals', () => {
  it('a case without an analysis is FAT_CASE_INVALID, an analysis without results FAT_RESULTS_MISSING, results without any finite node FAT_RESULTS_MISSING', () => {
    const b = build('swt', { low: [50, 0], high: [45, 200] });
    const durability = (b.doc as unknown as { analysis: { durability: { fatigueCases: Record<string, Record<string, unknown>> } } })
      .analysis.durability;
    const { analysisId, ...rest } = durability.fatigueCases[b.caseId] ?? {};
    void analysisId;
    const history = {
      ...b.doc,
      analysis: {
        ...(b.doc as unknown as { analysis: object }).analysis,
        durability: { ...durability, fatigueCases: { [b.caseId]: rest } },
      },
    } as unknown as CadDocument;
    expect(fatigueFieldInput(history, b.caseId, b.f.store)).toMatchObject({ code: 'FAT_CASE_INVALID' });
    const analysis = caseOf(b.doc, b.f.analysisId);
    if (analysis === undefined) throw new Error('no analysis');
    const { results, ...unsolved } = analysis;
    void results;
    expect(fatigueFieldInput(withCase(b.doc, unsolved), b.caseId, b.f.store)).toMatchObject({ code: 'FAT_RESULTS_MISSING' });
    expect(() =>
      build('swt', { low: [50, 0], high: [45, 200] }, (values, step) => {
        if (step === 0) for (const key of Object.keys(values)) values[key] = [Number.NaN, 0, 0, 0, 0, 0];
      }),
    ).toThrow('no mesh node has a finite stress tensor');
  });
});
