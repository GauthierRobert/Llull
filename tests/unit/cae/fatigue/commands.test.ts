import { beforeAll, describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { CadDocument } from '@core/model/types';
import { FAT_PLANS, expectedValue, relativeError, runPlanBefore, runPlanFile, stepData } from './support';

const MINER = `${FAT_PLANS}/fat_history_only_miner.plan.json`;
const E1049_X100 = [-200, 100, -300, 500, -100, 300, -400, 400, -200];
type Json = Record<string, unknown>;
const data = (result: { data?: unknown }): Json => (result.data ?? {}) as Json;
const code = (result: { error?: { code: string } }): string | undefined => result.error?.code;

let base: CadDocument;
beforeAll(() => {
  base = runPlanBefore(MINER, 'define_load_history').document;
});

function withHistory(values: number[] = E1049_X100): { doc: CadDocument; historyId: string } {
  const result = execute(base, 'define_load_history', {
    name: 'h',
    kind: 'stress',
    unit: 'MPa',
    data: { form: 'series', values },
    source: { citation: 'test' },
  });
  return { doc: result.document, historyId: result.affected[0] ?? '' };
}

function withCase(extra: Json = {}): { doc: CadDocument; caseId: string } {
  const { doc, historyId } = withHistory();
  const result = execute(doc, 'create_fatigue_case', {
    name: 'c',
    method: 'stress_life',
    mapping: [{ historyId, scale: 1 }],
    material: { recordId: 'mat_test', modelId: 'sn1' },
    requiredLife: { value: 1000, unit: 'blocks' },
    ...extra,
  });
  return { doc: result.document, caseId: result.affected[0] ?? '' };
}

describe('load histories', () => {
  it('defines a history with a step-scoped id and keeps the input document untouched (pure)', () => {
    const before = JSON.stringify(base);
    const { doc, historyId } = withHistory();
    expect(historyId).toMatch(/^lh-/);
    expect(doc.analysis?.durability?.historyOrder).toEqual([historyId]);
    expect(doc.analysis?.durability?.histories[historyId]).toMatchObject({ kind: 'stress', unit: 'MPa', repeats: 'once' });
    expect(JSON.stringify(base)).toBe(before);
  });

  it.each([
    ['a single value', { kind: 'stress', unit: 'MPa', data: { form: 'series', values: [1] } }],
    ['an unknown unit', { kind: 'stress', unit: 'furlong', data: { form: 'series', values: [1, 2] } }],
    ['a load factor with a unit', { kind: 'load_factor', unit: 'MPa', data: { form: 'series', values: [1, 2] } }],
    ['a strain with a stress unit', { kind: 'strain', unit: 'MPa', data: { form: 'series', values: [1, 2] } }],
    ['no rows', { kind: 'stress', unit: 'MPa', data: { form: 'blocks', rows: [] } }],
    ['max < min', { kind: 'stress', unit: 'MPa', data: { form: 'blocks', rows: [{ max: 1, min: 2, cycles: 1 }] } }],
  ])('rejects %s with FAT_HISTORY_INVALID and no change', (_label, params) => {
    const result = execute(base, 'define_load_history', { name: 'h', source: { citation: 'x' }, ...params });
    expect(code(result)).toBe('FAT_HISTORY_INVALID');
    expect(result.affected).toEqual([]);
    expect(result.document).toBe(base);
  });

  it('rejects an empty citation and accepts a strain history and a load factor', () => {
    expect(
      code(
        execute(base, 'define_load_history', {
          name: 'h',
          kind: 'stress',
          unit: 'MPa',
          data: { form: 'series', values: [1, 2] },
          source: { citation: ' ' },
        }),
      ),
    ).toBe('FAT_HISTORY_INVALID');
    const strain = execute(base, 'define_load_history', {
      name: 's',
      kind: 'strain',
      unit: 'm/m',
      data: { form: 'series', values: [0, 0.01] },
      source: { citation: 'x' },
    });
    expect(strain.affected).toHaveLength(1);
    const factor = execute(base, 'define_load_history', {
      name: 'f',
      kind: 'load_factor',
      unit: '-',
      data: { form: 'series', values: [0, 1] },
      source: { citation: 'x' },
    });
    expect(factor.affected).toHaveLength(1);
  });

  it('updates, validates the merged history, and refuses unknown ids', () => {
    const { doc, historyId } = withHistory();
    const updated = execute(doc, 'update_load_history', {
      historyId,
      name: 'renamed',
      unit: 'ksi',
      repeats: 'repeating',
      source: { citation: 'new' },
      data: { form: 'series', values: [0, 1, 0] },
    });
    expect(updated.document.analysis?.durability?.histories[historyId]).toMatchObject({
      name: 'renamed',
      unit: 'ksi',
      repeats: 'repeating',
    });
    expect(code(execute(doc, 'update_load_history', { historyId, unit: 'furlong' }))).toBe('FAT_HISTORY_INVALID');
    expect(code(execute(doc, 'update_load_history', { historyId: 'nope', name: 'x' }))).toBe('FAT_HISTORY_NOT_FOUND');
  });

  it('deletes an unused history; refuses unknown and in-use histories', () => {
    const { doc, historyId } = withHistory();
    const deleted = execute(doc, 'delete_load_history', { historyId });
    expect(deleted.document.analysis?.durability?.historyOrder).toEqual([]);
    expect(code(execute(doc, 'delete_load_history', { historyId: 'nope' }))).toBe('FAT_HISTORY_NOT_FOUND');
    const used = withCase();
    const historyInUse = Object.keys(used.doc.analysis?.durability?.histories ?? {})[0] ?? '';
    const refused = execute(used.doc, 'delete_load_history', { historyId: historyInUse });
    expect(code(refused)).toBe('FAT_HISTORY_IN_USE');
    expect(refused.error?.ids).toContain(used.caseId);
  });
});

describe('count_cycles', () => {
  it('VC-FAT-01 / 03 through the command: stored history, 3-point and repeating', () => {
    const { doc, historyId } = withHistory([-2, 1, -3, 5, -1, 3, -4, 4, -2]);
    const three = data(execute(doc, 'count_cycles', { historyId }));
    expect(three['totals']).toEqual(expectedValue('07-fatigue', 'VC-FAT-01'));
    expect(three['unit']).toBe('MPa');
    const repeating = data(execute(doc, 'count_cycles', { historyId, method: 'rainflow_repeating' }));
    expect(repeating['totals']).toEqual(expectedValue('07-fatigue', 'VC-FAT-03'));
  });

  it('four-point returns the residue; bins round ranges up; a blocks history counts its rows', () => {
    const inline = [-2, 1, -3, 5, -1, 3, -4, 4, -2];
    const four = data(execute(base, 'count_cycles', { history: inline.map((x) => -x), method: 'rainflow_4pt' }));
    expect(four['residue']).toEqual([2, -1, 3, -5, 4, -4, 2]);
    expect(four['totals']).toEqual(expectedValue('07-fatigue', 'VC-FAT-01'));
    const binned = data(execute(base, 'count_cycles', { history: inline, binSize: 5 }));
    expect(binned['totals']).toEqual([
      [5, 2],
      [10, 2],
    ]);
    const blocks = execute(base, 'define_load_history', {
      name: 'b',
      kind: 'stress',
      unit: 'MPa',
      data: { form: 'blocks', rows: [{ max: 100, min: 0, cycles: 3 }] },
      source: { citation: 'x' },
    });
    expect(data(execute(blocks.document, 'count_cycles', { historyId: blocks.affected[0] }))['totals']).toEqual([[100, 3]]);
  });

  it('is read-only (same document object, no affected ids)', () => {
    const result = execute(base, 'count_cycles', { history: [0, 1, 0] });
    expect(result.document).toBe(base);
    expect(result.affected).toEqual([]);
  });

  it.each([
    ['both inputs', { historyId: 'x', history: [0, 1] }, 'FAT_HISTORY_INVALID'],
    ['neither input', {}, 'FAT_HISTORY_INVALID'],
    ['unknown id', { historyId: 'nope' }, 'FAT_HISTORY_NOT_FOUND'],
    ['one value', { history: [1] }, 'FAT_HISTORY_INVALID'],
    ['bad bin', { history: [0, 1], binSize: 0 }, 'FAT_PARAMS_INVALID'],
    ['bad gate', { history: [0, 1], gate: -1 }, 'FAT_PARAMS_INVALID'],
    ['gate removing everything', { history: [0, 0.1, 0, 0.1], gate: 5 }, 'FAT_HISTORY_EMPTY'],
  ])('refuses %s', (_label, params, expected) => {
    expect(code(execute(base, 'count_cycles', params))).toBe(expected);
  });
});

describe('fatigue cases', () => {
  it('creates a case with named defaults and a step-scoped id', () => {
    const { doc, caseId } = withCase();
    expect(caseId).toMatch(/^fc-/);
    expect(doc.analysis?.durability?.fatigueCases[caseId]).toMatchObject({
      method: 'stress_life',
      meanStress: 'none',
      factors: { damageLimit: 1, compressiveMean: 'no_benefit', modifiers: [] },
      counting: { method: 'rainflow_3pt', residue: 'half_cycles' },
    });
    expect(doc.analysis?.durability?.fatigueCases[caseId]?.factors.scatter).toBeUndefined();
  });

  it.each([
    ['unknown history', { mapping: [{ historyId: 'nope', scale: 1 }] }, 'FAT_HISTORY_NOT_FOUND'],
    ['empty mapping', { mapping: [] }, 'FAT_CASE_INVALID'],
    ['unknown model', { material: { recordId: 'mat_test', modelId: 'zzz' } }, 'FAT_CURVE_MISSING'],
    ['unknown record', { material: { recordId: 'nope', modelId: 'sn1' } }, 'FAT_CURVE_MISSING'],
    ['wrong model kind', { material: { recordId: 'mat_test', modelId: 'en1' } }, 'FAT_CURVE_UNSUPPORTED'],
    ['unknown analysis', { analysisId: 'an-9.9' }, 'FAT_CASE_INVALID'],
    ['zero required life', { requiredLife: { value: 0, unit: 'blocks' } }, 'FAT_CASE_INVALID'],
    ['flights without blocksPerUnit', { requiredLife: { value: 10, unit: 'flights' } }, 'FAT_CASE_INVALID'],
    ['bad notch', { notch: { kt: 0.5, q: 0.5, feIncludesKt: false } }, 'FAT_CASE_INVALID'],
    [
      'strain-life without a cyclic model',
      { method: 'strain_life', material: { recordId: 'mat_test', modelId: 'en1' } },
      'FAT_CASE_INVALID',
    ],
    [
      'strain-life with a wrong cyclic model',
      { method: 'strain_life', material: { recordId: 'mat_test', modelId: 'en1', cyclicModelId: 'sn1' } },
      'FAT_CURVE_UNSUPPORTED',
    ],
    ['scatter below 1', { factors: { scatter: { value: 0.5, source: 'x' } } }, 'FAT_FACTOR_INVALID'],
  ])('refuses %s', (_label, extra, expected) => {
    const { doc, historyId } = withHistory();
    const result = execute(doc, 'create_fatigue_case', {
      name: 'c',
      method: 'stress_life',
      mapping: [{ historyId, scale: 1 }],
      material: { recordId: 'mat_test', modelId: 'sn1' },
      requiredLife: { value: 1000, unit: 'blocks' },
      ...extra,
    });
    expect(code(result)).toBe(expected);
    expect(result.document).toBe(doc);
    expect(result.affected).toEqual([]);
  });

  it('updates and deletes a case; unknown ids are refused', () => {
    const { doc, caseId } = withCase();
    const updated = execute(doc, 'update_fatigue_case', {
      caseId,
      name: 'renamed',
      meanStress: 'swt',
      factors: { scatter: { value: 2, source: 's' } },
    });
    expect(updated.document.analysis?.durability?.fatigueCases[caseId]).toMatchObject({
      name: 'renamed',
      meanStress: 'swt',
      factors: { scatter: { value: 2 } },
    });
    expect(code(execute(doc, 'update_fatigue_case', { caseId, material: { recordId: 'mat_test', modelId: 'zzz' } }))).toBe(
      'FAT_CURVE_MISSING',
    );
    expect(code(execute(doc, 'update_fatigue_case', { caseId, factors: { damageLimit: 0 } }))).toBe('FAT_FACTOR_INVALID');
    expect(code(execute(doc, 'update_fatigue_case', { caseId: 'nope', name: 'x' }))).toBe('FAT_CASE_NOT_FOUND');
    expect(execute(doc, 'delete_fatigue_case', { caseId }).document.analysis?.durability?.fatigueCaseOrder).toEqual([]);
    expect(code(execute(doc, 'delete_fatigue_case', { caseId: 'nope' }))).toBe('FAT_CASE_NOT_FOUND');
  });

  it('set_fatigue_factors validates scatter, modifiers, damage limit and band; unknown case is refused', () => {
    const { doc, caseId } = withCase();
    const good = execute(doc, 'set_fatigue_factors', {
      caseId,
      scatter: { value: 3, source: 'case input' },
      damageLimit: 0.5,
      marginalBand: 0.2,
      compressiveMean: 'formula',
      modifiers: [{ name: 'surface', value: 0.8, justification: 'machined' }],
    });
    expect(good.document.analysis?.durability?.fatigueCases[caseId]?.factors).toMatchObject({
      damageLimit: 0.5,
      marginalBand: 0.2,
      compressiveMean: 'formula',
    });
    for (const bad of [
      { scatter: { value: 3, source: ' ' } },
      { damageLimit: -1 },
      { marginalBand: -1 },
      { modifiers: [{ name: 'size', value: 0.9, justification: '' }] },
      { modifiers: [{ name: 'size', value: 0, justification: 'x' }] },
    ])
      expect(code(execute(doc, 'set_fatigue_factors', { caseId, ...bad }))).toBe('FAT_FACTOR_INVALID');
    expect(code(execute(doc, 'set_fatigue_factors', { caseId: 'nope', scatter: { value: 2, source: 'x' } }))).toBe('FAT_CASE_NOT_FOUND');
  });
});

describe('compute_fatigue and check_fatigue (VC-FAT-40, 41, 50, 60)', () => {
  const plan = (): ReturnType<typeof runPlanFile> => runPlanFile(MINER);

  it('the Miner plan reproduces damage per block, life in blocks and the margin of the pack', () => {
    const run = plan();
    expect(run.steps.every((s) => s.ok)).toBe(true);
    const computed = stepData(run, 'compute_fatigue');
    const row = (computed['rows'] as Json[])[0] as Json;
    expect(relativeError(row['damagePerBlock'] as number, expectedValue('07-fatigue', 'VC-FAT-40') as number)).toBeLessThan(1e-9);
    expect(relativeError(row['lifeBlocks'] as number, expectedValue('07-fatigue', 'VC-FAT-41') as number)).toBeLessThan(1e-9);
    expect(Math.abs((computed['minMargin'] as number) - (expectedValue('07-fatigue', 'VC-FAT-50') as number))).toBeLessThan(1e-9);
    expect(computed['factors']).toMatchObject({ scatter: { value: 3, defaulted: false }, damageLimit: { value: 1, defaulted: true } });
    expect(row).toMatchObject({
      status: 'PASS',
      reviewRequired: true,
      unverified: false,
      rangesMPa: [
        [300, 0.5],
        [400, 1.5],
        [600, 0.5],
        [800, 1],
        [900, 0.5],
      ],
    });
    expect(computed['reviewRequired']).toBe(true);
  });

  it('matches the closed form: Miner sum of count / ((range/2 / sigma_f)^(1/b) / 2) over the E1049 cycles', () => {
    const closed = [
      [300, 0.5],
      [400, 1.5],
      [600, 0.5],
      [800, 1],
      [900, 0.5],
    ].reduce((sum, [range = 0, count = 0]) => sum + count / ((range / 2 / 1160) ** (1 / -0.081) / 2), 0);
    const row = ((stepData(plan(), 'compute_fatigue')['rows'] as Json[])[0] ?? {}) as Json;
    expect(relativeError(row['damagePerBlock'] as number, closed)).toBeLessThan(1e-12);
  });

  it('the summary says the result is not approved', () => {
    const run = plan();
    expect(run.steps.find((s) => s.command === 'compute_fatigue')?.summary).toContain('not approved');
  });

  it('check_fatigue lists readiness items with codes and remediation', () => {
    const checked = stepData(plan(), 'check_fatigue');
    const items = checked['items'] as Array<{ code: string; remediation: string }>;
    expect(items.map((i) => i.code)).toEqual(
      expect.arrayContaining(['FAT_MEAN_MODEL_REQUIRED', 'FAT_MARGINAL_BAND_UNSET', 'FAT_CURVE_EXTRAPOLATED']),
    );
    expect(checked).toMatchObject({ status: 'warn', reviewRequired: true });
    expect(items.every((i) => typeof i.remediation === 'string')).toBe(true);
  });

  it('VC-FAT-60 i: no scatter factor is refused with FAT_SCATTER_FACTOR_UNSET and check_fatigue reports it as an error', () => {
    const { doc, caseId } = withCase();
    const refused = execute(doc, 'compute_fatigue', { caseId });
    expect(code(refused)).toBe('FAT_SCATTER_FACTOR_UNSET');
    expect(refused.document).toBe(doc);
    const checked = data(execute(doc, 'check_fatigue', { caseId }));
    expect(checked['status']).toBe('fail');
    expect(
      (checked['items'] as Array<{ code: string; severity: string }>).find((i) => i.code === 'FAT_SCATTER_FACTOR_UNSET')?.severity,
    ).toBe('error');
  });

  it('a short life fails with FAT_LIFE_SHORT, a marginal one warns, compute is read-only', () => {
    const { doc, caseId } = withCase({ requiredLife: { value: 1e6, unit: 'blocks' } });
    const factored = execute(doc, 'set_fatigue_factors', { caseId, scatter: { value: 3, source: 's' }, marginalBand: 0.5 }).document;
    const result = execute(factored, 'compute_fatigue', { caseId });
    expect(result.document).toBe(factored);
    expect(((data(result)['rows'] as Json[])[0] as Json)['status']).toBe('FAIL');
    expect((data(execute(factored, 'check_fatigue', { caseId }))['items'] as Array<{ code: string }>).map((i) => i.code)).toContain(
      'FAT_LIFE_SHORT',
    );
    const marginal = execute(factored, 'update_fatigue_case', { caseId, requiredLife: { value: 20000, unit: 'blocks' } }).document;
    expect(((data(execute(marginal, 'compute_fatigue', { caseId }))['rows'] as Json[])[0] as Json)['status']).toBe('MARGINAL');
  });

  it('required life in cycles and flights is converted to blocks', () => {
    const { doc, caseId } = withCase({ requiredLife: { value: 4000, unit: 'cycles' } });
    const factored = execute(doc, 'set_fatigue_factors', { caseId, scatter: { value: 1, source: 's' } }).document;
    const row = ((data(execute(factored, 'compute_fatigue', { caseId }))['rows'] as Json[])[0] ?? {}) as Json;
    expect(row['requiredBlocks']).toBe(1000);
    const flights = execute(factored, 'update_fatigue_case', {
      caseId,
      requiredLife: { value: 10, unit: 'flights', blocksPerUnit: 5 },
    }).document;
    expect(((data(execute(flights, 'compute_fatigue', { caseId }))['rows'] as Json[])[0] as Json)['requiredBlocks']).toBe(50);
  });

  it('Marin modifiers shorten life (VC-FAT-15 logic), a mean-stress model needs its strength, goodman uses Ftu', () => {
    const { doc, caseId } = withCase({ factors: { scatter: { value: 1, source: 's' } } });
    const life = (d: CadDocument): number =>
      ((data(execute(d, 'compute_fatigue', { caseId }))['rows'] as Json[])[0] as Json)['lifeBlocks'] as number;
    const reference = life(doc);
    const modified = execute(doc, 'set_fatigue_factors', {
      caseId,
      modifiers: [{ name: 'surface', value: 0.8, justification: 'machined' }],
    }).document;
    expect(life(modified)).toBeCloseTo(reference * 0.8 ** (1 / 0.081), -1);
    const goodman = execute(doc, 'update_fatigue_case', { caseId, meanStress: 'goodman' }).document;
    expect(life(goodman)).toBeLessThan(reference);
    const soderberg = execute(doc, 'update_fatigue_case', { caseId, meanStress: 'soderberg' }).document;
    expect(code(execute(soderberg, 'compute_fatigue', { caseId }))).toBe('FAT_ALLOWABLE_MISSING');
    const morrow = execute(doc, 'update_fatigue_case', { caseId, meanStress: 'morrow' }).document;
    expect(life(morrow)).toBeLessThan(reference);
    const swt = execute(doc, 'update_fatigue_case', { caseId, meanStress: { walker: 0.6 } }).document;
    expect(life(swt)).toBeGreaterThan(0);
  });

  it('a cycle at Ftu is a static failure with no life', () => {
    const { doc, historyId } = withHistory([0, 1500, 0]);
    const created = execute(doc, 'create_fatigue_case', {
      name: 'c',
      method: 'stress_life',
      mapping: [{ historyId, scale: 1 }],
      material: { recordId: 'mat_test', modelId: 'sn1' },
      requiredLife: { value: 1, unit: 'blocks' },
      factors: { scatter: { value: 1, source: 's' } },
    });
    const result = data(execute(created.document, 'compute_fatigue', { caseId: created.affected[0] }));
    const row = (result['rows'] as Json[])[0] as Json;
    expect(row['lifeBlocks']).toBeNull();
    expect(row['status']).toBe('FAIL');
    expect((result['items'] as Array<{ code: string }>).map((i) => i.code)).toContain('FAT_STATIC_FAILURE');
  });

  it('a strain-life case runs Neuber + SWT per cycle; walker is refused for strain-life', () => {
    const { doc, historyId } = withHistory([0, 375, 0, 375, 0]);
    const created = execute(doc, 'create_fatigue_case', {
      name: 'c',
      method: 'strain_life',
      mapping: [{ historyId, scale: 1 }],
      material: { recordId: 'mat_test', modelId: 'en1', cyclicModelId: 'ro1' },
      meanStress: 'swt',
      notch: { kt: 2.41, q: 0.9857, feIncludesKt: false },
      requiredLife: { value: 1, unit: 'blocks' },
      factors: { scatter: { value: 1, source: 's' } },
    });
    const caseId = created.affected[0] ?? '';
    const row = ((data(execute(created.document, 'compute_fatigue', { caseId }))['rows'] as Json[])[0] ?? {}) as Json;
    expect(row['damagePerBlock']).toBeGreaterThan(0);
    const morrow = execute(created.document, 'update_fatigue_case', { caseId, meanStress: 'morrow' }).document;
    expect(data(execute(morrow, 'compute_fatigue', { caseId }))['rows']).toHaveLength(1);
    const none = execute(created.document, 'update_fatigue_case', { caseId, meanStress: 'none' }).document;
    expect(data(execute(none, 'compute_fatigue', { caseId }))['rows']).toHaveLength(1);
    const walker = execute(created.document, 'update_fatigue_case', { caseId, meanStress: { walker: 0.6 } }).document;
    expect(code(execute(walker, 'compute_fatigue', { caseId }))).toBe('FAT_MEAN_MODEL_UNSUPPORTED');
  });

  it('refuses unknown cases, FE-driven cases, mismatched histories and non-stress histories', () => {
    expect(code(execute(base, 'compute_fatigue', { caseId: 'nope' }))).toBe('FAT_CASE_NOT_FOUND');
    expect(code(execute(base, 'check_fatigue', { caseId: 'nope' }))).toBe('FAT_CASE_NOT_FOUND');
    const withAnalysis = execute(base, 'create_analysis', { name: 'a', analysisType: 'static' }).document;
    const analysisId = Object.keys(withAnalysis.analysis?.cases ?? {})[0] ?? '';
    const { doc: withH, historyId } = (() => {
      const r = execute(withAnalysis, 'define_load_history', {
        name: 'h',
        kind: 'stress',
        unit: 'MPa',
        data: { form: 'series', values: [0, 1, 0] },
        source: { citation: 'x' },
      });
      return { doc: r.document, historyId: r.affected[0] ?? '' };
    })();
    const fe = execute(withH, 'create_fatigue_case', {
      name: 'fe',
      method: 'stress_life',
      analysisId,
      mapping: [{ historyId, scale: 1 }],
      material: { recordId: 'mat_test', modelId: 'sn1' },
      requiredLife: { value: 1, unit: 'blocks' },
      factors: { scatter: { value: 1, source: 's' } },
    });
    expect(code(execute(fe.document, 'compute_fatigue', { caseId: fe.affected[0] }))).toBe('FAT_RESULTS_MISSING');
    const second = execute(fe.document, 'define_load_history', {
      name: 'h2',
      kind: 'stress',
      unit: 'MPa',
      data: { form: 'series', values: [0, 1, 0, 1] },
      source: { citation: 'x' },
    });
    const mismatch = execute(second.document, 'update_fatigue_case', {
      caseId: fe.affected[0],
      analysisId: undefined,
      mapping: [
        { historyId, scale: 1 },
        { historyId: second.affected[0], scale: 1 },
      ],
    });
    expect(mismatch.affected).toHaveLength(1);
    const noFe = execute(second.document, 'create_fatigue_case', {
      name: 'm',
      method: 'stress_life',
      mapping: [
        { historyId, scale: 1 },
        { historyId: second.affected[0], scale: 1 },
      ],
      material: { recordId: 'mat_test', modelId: 'sn1' },
      requiredLife: { value: 1, unit: 'blocks' },
      factors: { scatter: { value: 1, source: 's' } },
    });
    expect(code(execute(noFe.document, 'compute_fatigue', { caseId: noFe.affected[0] }))).toBe('FAT_HISTORY_MISMATCH');
    const factor = execute(second.document, 'define_load_history', {
      name: 'lf',
      kind: 'load_factor',
      unit: '-',
      data: { form: 'series', values: [0, 1] },
      source: { citation: 'x' },
    });
    const lf = execute(factor.document, 'create_fatigue_case', {
      name: 'lf',
      method: 'stress_life',
      mapping: [{ historyId: factor.affected[0], scale: 1 }],
      material: { recordId: 'mat_test', modelId: 'sn1' },
      requiredLife: { value: 1, unit: 'blocks' },
      factors: { scatter: { value: 1, source: 's' } },
    });
    expect(code(execute(lf.document, 'compute_fatigue', { caseId: lf.affected[0] }))).toBe('FAT_HISTORY_INVALID');
  });

  it('an unverified curve basis is flagged on the row and in check_fatigue (VC-FAT-60 iii)', () => {
    const { doc, historyId } = withHistory();
    const typical = execute(doc, 'add_material_model', {
      material: 'mat_test',
      id: 'sn_typ',
      model: { kind: 'sn_basquin', sigmaF: { value: 1160, unit: 'MPa' }, b: -0.081, conditions: { probability: 'mean', control: 'load' } },
      basis: 'typical',
      source: { citation: 'handbook typical' },
    });
    const created = execute(typical.document, 'create_fatigue_case', {
      name: 'u',
      method: 'stress_life',
      mapping: [{ historyId, scale: 1 }],
      material: { recordId: 'mat_test', modelId: 'sn_typ' },
      requiredLife: { value: 1, unit: 'blocks' },
      factors: { scatter: { value: 1, source: 's' } },
    });
    const caseId = created.affected[0] ?? '';
    const row = ((data(execute(created.document, 'compute_fatigue', { caseId }))['rows'] as Json[])[0] ?? {}) as Json;
    expect(row['unverified']).toBe(true);
    expect((data(execute(created.document, 'check_fatigue', { caseId }))['items'] as Array<{ code: string }>).map((i) => i.code)).toContain(
      'FAT_CURVE_UNVERIFIED',
    );
  });
});
