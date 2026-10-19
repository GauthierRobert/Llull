import { beforeAll, describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { FeResultsArtifact } from '@core/model/analysis';
import { isEvaluationFailure } from '@cae/fatigue/evaluate';
import {
  fatigueFieldArtifact,
  fatigueFieldInput,
  fatigueFieldReference,
  FIELD_COMPONENTS,
  readFatigueField,
  type FatigueFieldInput,
} from '@cae/fatigue/feField';
import { maxPrincipal, measureOf, nodeSeries, principalExtremes, signedVonMises } from '@cae/fatigue/feStress';
import { feFatigue, type FeFatigue } from './feFixtures';
import { stressTensors } from './stressTensors';

type Json = Record<string, unknown>;
const data = (result: { data?: unknown }): Json => (result.data ?? {}) as Json;
const code = (result: { error?: { code: string } }): string | undefined => result.error?.code;

function inputOf(fixture: FeFatigue, caseId = fixture.caseId): FatigueFieldInput {
  const input = fatigueFieldInput(fixture.doc, caseId, fixture.store);
  if (isEvaluationFailure(input)) throw new Error(input.message);
  return input;
}

/** Stores the TypeScript reference field as if the native job had written it. */
function storeField(fixture: FeFatigue, input: FatigueFieldInput, field = fatigueFieldReference(input)): string {
  const artifact = fatigueFieldArtifact(input, field, 'test');
  if (typeof artifact === 'string') throw new Error(artifact);
  const hash = fixture.store.put(artifact);
  fixture.store.alias(input.key, hash);
  return hash;
}

describe('FE stress measures (feStress)', () => {
  it('principal extremes, signed von Mises and components', () => {
    expect(principalExtremes([100, 0, 0, 0, 0, 0])).toEqual([100, 0]);
    const [high, low] = principalExtremes([0, 0, 0, 50, 0, 0]);
    expect(high).toBeCloseTo(50, 12);
    expect(low).toBeCloseTo(-50, 12);
    const [h3, l3] = principalExtremes([10, 20, 30, 5, 6, 7]);
    const trace = 60;
    expect(h3).toBeGreaterThan(30);
    expect(l3).toBeLessThan(10);
    expect(h3 + l3).toBeLessThan(trace);
    expect(maxPrincipal([0, 0, 0, 50, 0, 0])).toBeCloseTo(50, 12);
    expect(maxPrincipal([-100, 0, 0, 0, 0, 0])).toBe(0);
    expect(maxPrincipal([0, 0, 0, 0, 0, 0])).toBe(0);
    expect(signedVonMises([0, 0, 0, 50, 0, 0])).toBeGreaterThan(0);
    expect(signedVonMises([-70, -70, -70, 0, 0, 0])).toBe(0);
    expect(signedVonMises([-100, -100, 0, 0, 0, 0])).toBe(-100);
    expect(signedVonMises([30, -100, 0, 0, 0, 0])).toBeLessThan(0);
    expect(measureOf([-100, 0, 0, 0, 0, 0], { kind: 'signed_von_mises' })).toBe(-100);
    expect(measureOf([100, 0, 0, 0, 0, 0], { kind: 'max_principal' })).toBe(100);
    expect(measureOf([1, 2, 3, 4, 5, 6], { kind: 'component', index: 5 })).toBe(6);
    expect(Number.isNaN(measureOf([1, 2], { kind: 'component', index: 4 }))).toBe(true);
    expect(
      nodeSeries(
        [
          [100, 0, 0, 0, 0, 0],
          [0, 10, 0, 0, 0, 0],
        ],
        [
          [1, -1],
          [0, 2],
        ],
        { kind: 'component', index: 1 },
      ),
    ).toEqual([0, 20]);
  });

  it('max principal and the signed von Mises sign agree with cyclic Jacobi to round-off (degenerate spectra included)', () => {
    let worst = 0;
    for (const tensor of stressTensors()) {
      const norm = Math.hypot(...tensor);
      const [high, low] = principalExtremes(tensor);
      worst = Math.max(worst, Math.abs(maxPrincipal(tensor) - high) / Math.max(norm, Number.MIN_VALUE));
      if (Math.abs(high + low) > 1e-9 * norm) expect(signedVonMises(tensor) < 0, String(tensor)).toBe(Math.abs(high) < Math.abs(low));
    }
    expect(worst).toBeLessThan(1e-13);
  });
});

describe('fatigue field (TR-FAT-41)', () => {
  let fixture: FeFatigue;
  beforeAll(() => {
    fixture = feFatigue();
  });

  it('builds the native job of every node from the trusted results, keyed by the case input hash', () => {
    const input = inputOf(fixture);
    expect(input.job).toMatchObject({ task: 'fatigue', nodeCount: 45, loadCases: 2, steps: 40, measure: { kind: 'signed_von_mises' } });
    expect(input.tensors).toHaveLength(45 * 2 * 6);
    expect(input.job.damage).toMatchObject({
      method: 'stress_life',
      curve: { kind: 'sn_basquin', sigmaF: 1160 },
      mean: { model: 'goodman', su: 900 },
    });
    expect(input.key).toMatch(/^[0-9a-f]{64}$/);
    expect(inputOf(fixture).key).toBe(input.key);
    const scatter = execute(fixture.doc, 'set_fatigue_factors', { caseId: fixture.caseId, scatter: { value: 4, source: 'x' } }).document;
    expect(inputOf({ ...fixture, doc: scatter }).key).toBe(input.key);
    const curve = execute(fixture.doc, 'update_fatigue_case', { caseId: fixture.caseId, meanStress: 'gerber' }).document;
    expect(inputOf({ ...fixture, doc: curve }).key).not.toBe(input.key);
  });

  it('compute_fatigue ranks hot spots by damage over all nodes and recomputes each row in TypeScript (pure)', () => {
    const input = inputOf(fixture);
    const reference = fatigueFieldReference(input);
    storeField(fixture, input, reference);
    const before = JSON.stringify(fixture.doc);
    const result = execute(fixture.doc, 'compute_fatigue', { caseId: fixture.caseId }, fixture.ctx);
    expect(JSON.stringify(fixture.doc)).toBe(before);
    expect(result.document).toBe(fixture.doc);
    const out = data(result);
    expect(out).toMatchObject({ selection: 'all_nodes', nodesEvaluated: 45, fatigueInputHash: input.key, reviewRequired: true });
    const rows = out['rows'] as Json[];
    expect(rows.map((row) => row['rowKey'])).toEqual(['h1', 'h2', 'h3']);
    const width = FIELD_COMPONENTS.length;
    const damages = input.nodeIds.map((_, index) => reference[index * width] ?? 0).sort((a, b) => b - a);
    expect(rows.map((row) => row['damagePerBlock'])).toEqual(damages.slice(0, 3));
    for (const row of rows) expect(row['damagePerBlock']).toBe(row['nativeDamagePerBlock']);
    expect(rows[0]).toMatchObject({
      part: expect.any(String),
      status: expect.stringMatching(/PASS|MARGINAL|FAIL/),
      selection: 'all_nodes',
    });
    expect(result.summary).toContain('ranked by damage over all 45 nodes');
    const check = data(execute(fixture.doc, 'check_fatigue', { caseId: fixture.caseId }, fixture.ctx));
    expect((check['items'] as Json[]).map((entry) => entry['code'])).not.toContain('FAT_RESULTS_MISSING');
  });

  it('flags a native field that disagrees with the reference and refuses a field bound to something else', () => {
    const local = feFatigue({ seed: 11 });
    const input = inputOf(local);
    const field = fatigueFieldReference(input);
    let top = 0;
    for (let index = 0; index < input.nodeIds.length; index += 1) if ((field[index * 4] ?? 0) > (field[top * 4] ?? 0)) top = index;
    field[top * 4] = (field[top * 4] ?? 0) * 2;
    storeField(local, input, field);
    const items = data(execute(local.doc, 'compute_fatigue', { caseId: local.caseId }, local.ctx))['items'] as Json[];
    expect(items.map((entry) => entry['code'])).toContain('FAT_NATIVE_MISMATCH');
    const artifact = fatigueFieldArtifact(input, fatigueFieldReference(input), 'test') as FeResultsArtifact;
    const forged = local.store.put({ ...artifact, inputHash: '0'.repeat(64) });
    local.store.alias(input.key, forged);
    expect(code(execute(local.doc, 'compute_fatigue', { caseId: local.caseId }, local.ctx))).toBe('FAT_FIELD_INVALID');
    const holes = local.store.put({ ...artifact, steps: [{ step: 1, time: 0, fields: { FATIGUE: { components: [], values: {} } } }] });
    local.store.alias(input.key, holes);
    expect(isEvaluationFailure(readFatigueField(local.store, input))).toBe(true);
    expect(fatigueFieldArtifact(input, new Float64Array(3), 'x')).toMatch(/expected/);
    const nan = fatigueFieldReference(input);
    nan[1] = Number.NaN;
    expect(fatigueFieldArtifact(input, nan, 'x')).toMatch(/not finite/);
  });

  it('refuses a missing field, stale results, unsolved analyses and bad mappings', () => {
    const local = feFatigue({ seed: 3 });
    expect(code(execute(local.doc, 'compute_fatigue', { caseId: local.caseId }, local.ctx))).toBe('FAT_RESULTS_MISSING');
    expect(code(execute(local.doc, 'compute_fatigue', { caseId: local.caseId }))).toBe('FAT_RESULTS_MISSING');
    const stale = execute(local.doc, 'add_fea_load', {
      analysisId: local.analysisId,
      name: 'more',
      kind: 'force',
      loadCase: 'LC1',
      category: 'limit',
      vector: [5, 0, 0],
      target: { entityId: Object.keys(local.doc.entities)[0], facesNear: [[2, 0.5, 0.5]] },
    }).document;
    expect(code(execute(stale, 'compute_fatigue', { caseId: local.caseId }, local.ctx))).toBe('FAT_RESULTS_STALE');
    const noScatter = execute(local.doc, 'create_fatigue_case', {
      name: 'n',
      method: 'stress_life',
      analysisId: local.analysisId,
      mapping: [{ loadCase: 'LC1', historyId: local.histories[0], scale: 1 }],
      material: { recordId: 'steel', modelId: 'sn1' },
      requiredLife: { value: 10, unit: 'blocks' },
    });
    expect(code(execute(noScatter.document, 'compute_fatigue', { caseId: noScatter.affected[0] }, local.ctx))).toBe(
      'FAT_SCATTER_FACTOR_UNSET',
    );
    const failures: Array<[string, Json, string]> = [
      ['unknown load case', { mapping: [{ loadCase: 'LC9', historyId: local.histories[0], scale: 1 }] }, 'FAT_CASE_INVALID'],
      ['ambiguous load case', { mapping: [{ historyId: local.histories[0], scale: 1 }] }, 'FAT_CASE_INVALID'],
    ];
    for (const [, params, expected] of failures) {
      const updated = execute(local.doc, 'update_fatigue_case', { caseId: local.caseId, ...params }).document;
      const result = fatigueFieldInput(updated, local.caseId, local.store);
      expect(isEvaluationFailure(result) ? result.code : 'ok').toBe(expected);
    }
    const stressHistory = execute(local.doc, 'define_load_history', {
      name: 's',
      kind: 'stress',
      unit: 'MPa',
      data: { form: 'series', values: [0, 1, 0] },
      source: { citation: 'x' },
    });
    const withStress = execute(stressHistory.document, 'update_fatigue_case', {
      caseId: local.caseId,
      mapping: [{ loadCase: 'LC1', historyId: stressHistory.affected[0], scale: 1 }],
    }).document;
    expect(isEvaluationFailure(fatigueFieldInput(withStress, local.caseId, local.store))).toBe(true);
    const short = execute(local.doc, 'define_load_history', {
      name: 'short',
      kind: 'load_factor',
      unit: '-',
      data: { form: 'series', values: [0, 1, 0] },
      source: { citation: 'x' },
    });
    const mismatch = execute(short.document, 'update_fatigue_case', {
      caseId: local.caseId,
      mapping: [
        { loadCase: 'LC1', historyId: local.histories[0], scale: 1 },
        { loadCase: 'LC2', historyId: short.affected[0], scale: 1 },
      ],
    }).document;
    const mismatched = fatigueFieldInput(mismatch, local.caseId, local.store);
    expect(isEvaluationFailure(mismatched) ? mismatched.code : 'ok').toBe('FAT_HISTORY_MISMATCH');
    const blocks = execute(local.doc, 'define_load_history', {
      name: 'b',
      kind: 'load_factor',
      unit: '-',
      data: { form: 'blocks', rows: [{ max: 1, min: -1, cycles: 10 }] },
      source: { citation: 'x' },
    });
    const withBlocks = execute(blocks.document, 'update_fatigue_case', {
      caseId: local.caseId,
      mapping: [{ loadCase: 'LC1', historyId: blocks.affected[0], scale: 1 }],
    }).document;
    const blocked = fatigueFieldInput(withBlocks, local.caseId, local.store);
    expect(isEvaluationFailure(blocked) ? blocked.code : 'ok').toBe('FAT_HISTORY_MISMATCH');
    const historyOnly = execute(local.doc, 'update_fatigue_case', { caseId: local.caseId, analysisId: undefined });
    expect(historyOnly.document).toBeDefined();
    expect(isEvaluationFailure(fatigueFieldInput(local.doc, 'nope', local.store))).toBe(true);
  });

  it('builds strain-life, power-law and table jobs and the other measures', () => {
    const variants: Json[] = [
      {
        method: 'strain_life',
        material: { recordId: 'steel', modelId: 'en1', cyclicModelId: 'ro1' },
        meanStress: 'swt',
        measure: 'max_principal',
      },
      {
        material: { recordId: 'steel', modelId: 'sn2' },
        meanStress: 'none',
        measure: { component: 'sxx' },
        notch: { kt: 2, q: 0.9, feIncludesKt: false },
      },
      {
        material: { recordId: 'steel', modelId: 'sn3' },
        meanStress: 'soderberg',
        counting: { method: 'rainflow_4pt', residue: 'half_cycles', gate: 5 },
      },
    ];
    for (const caseParams of variants) {
      const local = feFatigue({ seed: 5, cells: [2, 1, 1], caseParams });
      const input = inputOf(local);
      const reference = fatigueFieldReference(input);
      expect(reference.every((value) => Number.isFinite(value))).toBe(true);
      storeField(local, input, reference);
      const result = execute(local.doc, 'compute_fatigue', { caseId: local.caseId }, local.ctx);
      expect(result.rejected).not.toBe(true);
      expect((data(result)['rows'] as Json[]).length).toBe(3);
    }
  });

  it('ranks static failures first and reports no margin for them', () => {
    const local = feFatigue({ seed: 9, cells: [2, 1, 1] });
    const scaled = execute(local.doc, 'update_fatigue_case', {
      caseId: local.caseId,
      mapping: [
        { loadCase: 'LC1', historyId: local.histories[0], scale: 20 },
        { loadCase: 'LC2', historyId: local.histories[1], scale: 0.5 },
      ],
    }).document;
    const fixture = { ...local, doc: scaled };
    storeField(fixture, inputOf(fixture));
    const out = data(execute(scaled, 'compute_fatigue', { caseId: local.caseId }, local.ctx));
    expect(out['minMargin']).toBeNull();
    expect(out['status']).toBe('FAIL');
    expect((out['rows'] as Json[])[0]).toMatchObject({ lifeBlocks: null, status: 'FAIL' });
  });
});
