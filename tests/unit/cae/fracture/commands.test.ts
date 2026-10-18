import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { CadDocument } from '@core/model/types';
import { FRC_PLANS, expectedValue, runPlanFile, stepData } from '../fatigue/support';
import { build, code, data, materialDoc, mm, relative, type Json } from './support';

const PACK = '08-fracture-damage-tolerance';
const PARIS_PLAN = `${FRC_PLANS}/frc_paris_center_life.plan.json`;
const RESIDUAL_PLAN = `${FRC_PLANS}/frc_residual_interval.plan.json`;
const PI = Math.PI;

const parisClosedForm = (a0: number, af: number, ds: number, C = 1e-11, m = 3): number =>
  m === 2
    ? Math.log(af / a0) / (C * PI * ds * ds)
    : (a0 ** (1 - m / 2) - af ** (1 - m / 2)) / (C * (m / 2 - 1) * (ds * Math.sqrt(PI)) ** m);

describe('cracks', () => {
  it('defines, updates and deletes a crack; the input document is not mutated', () => {
    const doc = materialDoc();
    const before = JSON.stringify(doc);
    const defined = execute(doc, 'define_crack', { name: 'c', geometry: { kind: 'center_through', a: mm(5), W: mm(200), t: mm(2) } });
    const crackId = defined.affected[0] ?? '';
    expect(crackId).toMatch(/^cr-/);
    expect(JSON.stringify(doc)).toBe(before);
    expect(defined.document.analysis?.durability?.crackOrder).toEqual([crackId]);
    const updated = execute(defined.document, 'update_crack', {
      crackId,
      name: 'renamed',
      geometry: { kind: 'edge_through', a: mm(5), b: mm(50), t: mm(2), form: 'tada' },
    });
    expect(updated.document.analysis?.durability?.cracks[crackId]).toMatchObject({ name: 'renamed', geometry: { kind: 'edge_through' } });
    expect(
      execute(updated.document, 'update_crack', { crackId, name: 'only name' }).document.analysis?.durability?.cracks[crackId]?.geometry
        .kind,
    ).toBe('edge_through');
    expect(execute(defined.document, 'delete_crack', { crackId }).document.analysis?.durability?.crackOrder).toEqual([]);
  });

  it.each([
    ['a >= W/2', { kind: 'center_through', a: mm(100), W: mm(200), t: mm(2) }],
    ['a >= b', { kind: 'edge_through', a: mm(60), b: mm(50), t: mm(2), form: 'tada' }],
    ['a >= t', { kind: 'surface_semi_elliptical', a: mm(12), c: mm(20), t: mm(10), b: mm(50) }],
    ['a/c > 1', { kind: 'surface_semi_elliptical', a: mm(6), c: mm(4), t: mm(10), b: mm(50) }],
    ['a length in MPa', { kind: 'center_through', a: { value: 1, unit: 'MPa' }, W: mm(200), t: mm(2) }],
  ])('rejects %s with FRC_CRACK_INVALID', (_label, geometry) => {
    const doc = materialDoc();
    const result = execute(doc, 'define_crack', { name: 'c', geometry });
    expect(code(result)).toBe('FRC_CRACK_INVALID');
    expect(result.document).toBe(doc);
    expect(result.affected).toEqual([]);
  });

  it('refuses unknown cracks on update / delete, an invalid update, and deleting a crack in use', () => {
    const built = build();
    expect(code(execute(built.doc, 'update_crack', { crackId: 'nope', name: 'x' }))).toBe('FRC_CRACK_NOT_FOUND');
    expect(code(execute(built.doc, 'delete_crack', { crackId: 'nope' }))).toBe('FRC_CRACK_NOT_FOUND');
    expect(
      code(
        execute(built.doc, 'update_crack', {
          crackId: built.crackId,
          geometry: { kind: 'center_through', a: mm(150), W: mm(200), t: mm(2) },
        }),
      ),
    ).toBe('FRC_CRACK_INVALID');
    const inUse = execute(built.doc, 'delete_crack', { crackId: built.crackId });
    expect(code(inUse)).toBe('FRC_CRACK_IN_USE');
    expect(inUse.error?.ids).toContain(built.caseId);
  });
});

describe('crack-growth cases', () => {
  it('creates a case with named defaults and the residual-interval set-up', () => {
    const built = build();
    expect(built.caseId).toMatch(/^cg-/);
    const stored = built.doc.analysis?.durability?.crackGrowthCases[built.caseId];
    expect(stored).toMatchObject({ sequence: 'cycle_by_cycle', integration: { maxDaOverA: 0.01 }, factors: {} });
  });

  it('deletes a case and a history becomes deletable; unknown case refused', () => {
    const built = build();
    expect(code(execute(built.doc, 'delete_load_history', { historyId: built.historyId }))).toBe('FAT_HISTORY_IN_USE');
    const removed = execute(built.doc, 'delete_crack_growth_case', { caseId: built.caseId });
    expect(removed.document.analysis?.durability?.crackGrowthCaseOrder).toEqual([]);
    expect(code(execute(removed.document, 'delete_crack_growth_case', { caseId: built.caseId }))).toBe('FRC_CASE_NOT_FOUND');
  });

  it('set_damage_tolerance_factors merges and validates', () => {
    const built = build();
    const set = execute(built.doc, 'set_damage_tolerance_factors', {
      caseId: built.caseId,
      scatterInterval: { value: 2, source: 'owner' },
      scatterThreshold: { value: 3, source: 'owner' },
      marginalBand: 0.1,
    });
    expect(set.document.analysis?.durability?.crackGrowthCases[built.caseId]?.factors).toMatchObject({
      scatterInterval: { value: 2 },
      scatterThreshold: { value: 3 },
      marginalBand: 0.1,
    });
    for (const bad of [
      { scatterInterval: { value: 0.5, source: 'x' } },
      { scatterThreshold: { value: 2, source: ' ' } },
      { marginalBand: -1 },
    ])
      expect(code(execute(built.doc, 'set_damage_tolerance_factors', { caseId: built.caseId, ...bad }))).toBe('FRC_FACTOR_INVALID');
    expect(code(execute(built.doc, 'set_damage_tolerance_factors', { caseId: 'nope', marginalBand: 1 }))).toBe('FRC_CASE_NOT_FOUND');
  });

  it('refuses unresolved references and bad sizes without changing the document', () => {
    const built = build();
    const doc = built.doc;
    const params = {
      name: 'g2',
      crackId: built.crackId,
      material: { recordId: 'dt_test', growthModelId: 'paris1', toughnessModelId: 'kc1' },
      histories: [{ historyId: built.historyId, scale: 1 }],
      growth: { aInitial: mm(5) },
    };
    const cases: Array<[string, Json, string]> = [
      ['unknown crack', { crackId: 'nope' }, 'FRC_CRACK_NOT_FOUND'],
      ['unknown growth model', { material: { ...params.material, growthModelId: 'zzz' } }, 'FRC_MODEL_MISSING'],
      ['unknown toughness model', { material: { ...params.material, toughnessModelId: 'zzz' } }, 'FRC_MODEL_MISSING'],
      ['toughness model used as a growth law', { material: { ...params.material, growthModelId: 'kc1' } }, 'FRC_MODEL_MISSING'],
      ['growth law used as toughness', { material: { ...params.material, toughnessModelId: 'paris1' } }, 'FRC_UNITS_MISMATCH'],
      ['unknown history', { histories: [{ historyId: 'nope', scale: 1 }] }, 'FRC_CASE_INVALID'],
      ['empty histories', { histories: [] }, 'FRC_CASE_INVALID'],
      ['aInitial in a stress unit', { growth: { aInitial: { value: 1, unit: 'MPa' } } }, 'FRC_CASE_INVALID'],
      ['aTarget <= 0', { growth: { aInitial: mm(5), aTarget: mm(-1) } }, 'FRC_CASE_INVALID'],
      ['bad maxDaOverA', { integration: { maxDaOverA: 0 } }, 'FRC_PARAMS_INVALID'],
      ['bad factor', { factors: { scatterInterval: { value: 0.1, source: 'x' } } }, 'FRC_FACTOR_INVALID'],
      ['residual stress of 0', { residualStrengthStress: { value: 0, unit: 'MPa' } }, 'FRC_CASE_INVALID'],
    ];
    for (const [label, override, expected] of cases) {
      const result = execute(doc, 'create_crack_growth_case', { ...params, ...override });
      expect(code(result), label).toBe(expected);
      expect(result.document, label).toBe(doc);
    }
  });

  it('rejects a non-stress history and a compressive-only history', () => {
    const base = build();
    const factor = execute(base.doc, 'define_load_history', {
      name: 'lf',
      kind: 'load_factor',
      unit: '-',
      data: { form: 'series', values: [0, 1] },
      source: { citation: 'x' },
    });
    const compressive = execute(factor.document, 'define_load_history', {
      name: 'c',
      kind: 'stress',
      unit: 'MPa',
      data: { form: 'series', values: [-10, -1, -10] },
      source: { citation: 'x' },
    });
    const params = {
      name: 'g',
      crackId: base.crackId,
      material: { recordId: 'dt_test', growthModelId: 'paris1', toughnessModelId: 'kc1' },
      growth: { aInitial: mm(5) },
    };
    expect(
      code(
        execute(compressive.document, 'create_crack_growth_case', { ...params, histories: [{ historyId: factor.affected[0], scale: 1 }] }),
      ),
    ).toBe('FRC_CASE_INVALID');
    expect(
      code(
        execute(compressive.document, 'create_crack_growth_case', {
          ...params,
          histories: [{ historyId: compressive.affected[0], scale: 1 }],
        }),
      ),
    ).toBe('FRC_NO_STRESS');
  });

  it('a surface crack cannot be integrated (unconfirmed solution)', () => {
    const base = build();
    const surface = execute(base.doc, 'define_crack', {
      name: 's',
      geometry: { kind: 'surface_semi_elliptical', a: mm(2), c: mm(4), t: mm(10), b: mm(50) },
    });
    const result = execute(surface.document, 'create_crack_growth_case', {
      name: 'g',
      crackId: surface.affected[0],
      material: { recordId: 'dt_test', growthModelId: 'paris1', toughnessModelId: 'kc1' },
      histories: [{ historyId: base.historyId, scale: 1 }],
      growth: { aInitial: mm(2) },
    });
    expect(code(result)).toBe('FRC_K_SOLUTION_UNCONFIRMED');
  });
});

describe('compute_crack_growth (VC-FRC-05..07, 13)', () => {
  it('VC-FRC-05: the Paris plan matches the closed form N = (a0^(1-m/2) - af^(1-m/2)) / (C (m/2-1) (ds sqrt(pi))^m) to 1e-6', () => {
    const run = runPlanFile(PARIS_PLAN);
    expect(run.steps.every((step) => step.ok)).toBe(true);
    const result = stepData(run, 'compute_crack_growth');
    expect(relative(result['lifeCycles'] as number, parisClosedForm(0.001, 0.01, 100))).toBeLessThan(1e-6);
    expect(relative(result['lifeCycles'] as number, expectedValue(PACK, 'VC-FRC-05') as number)).toBeLessThan(1e-6);
    expect(relative(result['lifeCycles'] as number, expectedValue(PACK, 'VC-FRC-06') as number)).toBeLessThan(1e-3);
    expect(result).toMatchObject({ stopReason: 'target', reviewRequired: true, unverified: false });
  });

  it('exact closed form for the m = 2 branch and other exponents with a very wide plate', () => {
    for (const m of [2, 2.5, 4]) {
      let doc = materialDoc();
      doc = execute(doc, 'add_material_model', {
        material: 'dt_test',
        id: 'pm',
        model: { kind: 'da_dn_paris', C: 1e-11, m, units: 'm/cycle|MPa*m^0.5', conditions: {} },
        basis: 'company',
        source: { citation: 'test' },
      }).document;
      const built = build({
        doc,
        geometry: { a: mm(1), W: { value: 1e9, unit: 'mm' } },
        history: { data: { form: 'blocks', rows: [{ max: 100, min: 0, cycles: 1 }] } },
        growth: { aInitial: mm(1), aTarget: mm(10) },
        growthModelId: 'pm',
      });
      const life = data(execute(built.doc, 'compute_crack_growth', { caseId: built.caseId }))['lifeCycles'] as number;
      expect(relative(life, parisClosedForm(0.001, 0.01, 100, 1e-11, m)), `m = ${m}`).toBeLessThan(1e-7);
    }
  });

  it('VC-FRC-07: secant, W 200 mm, 5 -> 40 mm, 150 MPa gives 92454.92 cycles', () => {
    const built = build({ growth: { aInitial: mm(5), aTarget: mm(40) } });
    const life = data(execute(built.doc, 'compute_crack_growth', { caseId: built.caseId }))['lifeCycles'] as number;
    expect(relative(life, expectedValue(PACK, 'VC-FRC-07') as number)).toBeLessThan(1e-6);
  });

  it('VC-FRC-13: 5 mm to a_crit takes 92841.15 cycles and stops by fracture; the curve is bounded and monotone', () => {
    const run = runPlanFile(RESIDUAL_PLAN);
    const result = stepData(run, 'compute_crack_growth');
    expect(relative(result['lifeCycles'] as number, expectedValue(PACK, 'VC-FRC-13') as number)).toBeLessThan(1e-6);
    expect(result['stopReason']).toBe('fracture');
    expect(relative(result['aCriticalM'] as number, expectedValue(PACK, 'VC-FRC-10') as number)).toBeLessThan(1e-9);
    expect(relative(result['aNetYieldM'] as number, expectedValue(PACK, 'VC-FRC-11') as number)).toBeLessThan(1e-12);
    const curve = result['curve'] as Array<{ N: number; aM: number; KmaxMPaSqrtM: number }>;
    expect(curve).toHaveLength(201);
    expect(curve.every((p, i) => i === 0 || (p.N > (curve[i - 1]?.N ?? 0) && p.aM > (curve[i - 1]?.aM ?? 0)))).toBe(true);
    expect(curve.at(-1)?.KmaxMPaSqrtM).toBeCloseTo(60, 6);
  });

  it('a two-row block follows the summed closed form: C_eff = C sum(n_i ds_i^m)', () => {
    const rows = [
      { max: 100, min: 0, cycles: 2 },
      { max: 60, min: 10, cycles: 3 },
    ];
    const built = build({
      geometry: { a: mm(1), W: { value: 1e9, unit: 'mm' } },
      history: { data: { form: 'blocks', rows } },
      growth: { aInitial: mm(1), aTarget: mm(8) },
    });
    const result = data(execute(built.doc, 'compute_crack_growth', { caseId: built.caseId }));
    const perBlock = 2 * 100 ** 3 + 3 * 50 ** 3;
    const blocks = (0.001 ** -0.5 - 0.008 ** -0.5) / (1e-11 * 0.5 * Math.sqrt(PI) ** 3 * perBlock);
    expect(relative(result['lifeBlocks'] as number, blocks)).toBeLessThan(1e-6);
    expect(result['cyclesPerBlock']).toBe(5);
    expect(relative(result['lifeCycles'] as number, blocks * 5)).toBeLessThan(1e-6);
  });

  it('a series history: reversal pairs as half cycles equal the rainflow blocks of a simple repeated cycle', () => {
    const series = { data: { form: 'series', values: [0, 100, 0, 100, 0] } };
    const common = { geometry: { a: mm(1), W: { value: 1e9, unit: 'mm' } }, history: series, growth: { aInitial: mm(1), aTarget: mm(5) } };
    const byPairs = data(execute(...args(build({ ...common }))))['lifeCycles'] as number;
    const byRainflow = data(execute(...args(build({ ...common, extra: { sequence: 'rainflow_blocks' } }))))['lifeCycles'] as number;
    expect(relative(byPairs, byRainflow)).toBeLessThan(1e-9);
    expect(relative(byPairs, parisClosedForm(0.001, 0.005, 100))).toBeLessThan(1e-6);
  });

  it('Forman-type growth stops by fracture; runout is reported at 1e8 cycles; an arrested crack (below dKth) has infinite life', () => {
    const forman = execute(materialDoc(), 'add_material_model', {
      material: 'dt_test',
      id: 'fm',
      model: { kind: 'da_dn_forman', C: 1e-11, n: 3, Kc: 60, units: 'm/cycle|MPa*m^0.5', conditions: {} },
      basis: 'company',
      source: { citation: 'test' },
    });
    const withForman = build({ doc: forman.document, growthModelId: 'fm' });
    const formanResult = data(execute(withForman.doc, 'compute_crack_growth', { caseId: withForman.caseId }));
    expect(formanResult['stopReason']).toBe('fracture');
    expect(formanResult['lifeCycles']).toBeGreaterThan(1e4);
    const slow = execute(materialDoc(), 'add_material_model', {
      material: 'dt_test',
      id: 'slow',
      model: { kind: 'da_dn_paris', C: 1e-16, m: 3, dKth: 100, units: 'm/cycle|MPa*m^0.5', conditions: {} },
      basis: 'company',
      source: { citation: 'test' },
    });
    const arrest = build({ doc: slow.document, growthModelId: 'slow' });
    expect(data(execute(arrest.doc, 'compute_crack_growth', { caseId: arrest.caseId }))).toMatchObject({
      stopReason: 'arrest',
      lifeCycles: Number.POSITIVE_INFINITY,
    });
    const runout = execute(materialDoc(), 'add_material_model', {
      material: 'dt_test',
      id: 'tiny',
      model: { kind: 'da_dn_paris', C: 1e-17, m: 3, units: 'm/cycle|MPa*m^0.5', conditions: {} },
      basis: 'company',
      source: { citation: 'test' },
    });
    const capped = build({ doc: runout.document, growthModelId: 'tiny' });
    const cappedResult = data(execute(capped.doc, 'compute_crack_growth', { caseId: capped.caseId }));
    expect(cappedResult).toMatchObject({ stopReason: 'runout', lifeCycles: 1e8 });
    expect((cappedResult['items'] as Array<{ code: string }>).map((i) => i.code)).toContain('FRC_RUNOUT');
  });

  it('net-section yield governs for a narrow plate; geometry limit when nothing else stops; initial-critical gives life 0', () => {
    const narrow = build({
      geometry: { a: mm(5), W: mm(40) },
      history: { data: { form: 'blocks', rows: [{ max: 250, min: 0, cycles: 1 }] } },
      growth: { aInitial: mm(2) },
      extra: { residualStrengthStress: { value: 250, unit: 'MPa' } },
    });
    expect(data(execute(narrow.doc, 'compute_crack_growth', { caseId: narrow.caseId }))['stopReason']).toBe('net_section_yield');
    const wide = build({ history: { data: { form: 'blocks', rows: [{ max: 40, min: 0, cycles: 1 }] } }, growth: { aInitial: mm(5) } });
    expect(data(execute(wide.doc, 'compute_crack_growth', { caseId: wide.caseId, samples: 10 }))['stopReason']).toBe('geometry_limit');
    const critical = build({ geometry: { a: mm(40) }, growth: { aInitial: mm(40.9) } });
    const result = execute(critical.doc, 'compute_crack_growth', { caseId: critical.caseId });
    expect(data(result)).toMatchObject({ stopReason: 'initial_critical', lifeCycles: 0 });
    expect(
      (data(result)['items'] as Array<{ code: string; severity: string }>).find((i) => i.code === 'FRC_INITIAL_CRITICAL')?.severity,
    ).toBe('fail');
  });

  it('is read-only and flags unverified data; refuses unknown cases and sizes beyond the K solution', () => {
    const typical = execute(materialDoc(), 'add_material_model', {
      material: 'dt_test',
      id: 'kt',
      model: { kind: 'fracture_toughness', KIc: { value: 60, unit: 'MPa*m^0.5' }, state: 'plane_strain' },
      basis: 'typical',
      source: { citation: 'handbook typical' },
    });
    const built = build({ doc: typical.document });
    const withTypical = execute(built.doc, 'create_crack_growth_case', {
      name: 'u',
      crackId: built.crackId,
      material: { recordId: 'dt_test', growthModelId: 'paris1', toughnessModelId: 'kt' },
      histories: [{ historyId: built.historyId, scale: 1 }],
      growth: { aInitial: mm(5) },
    });
    const caseId = withTypical.affected[0] ?? '';
    const computed = execute(withTypical.document, 'compute_crack_growth', { caseId });
    expect(computed.document).toBe(withTypical.document);
    expect(computed.affected).toEqual([]);
    expect(data(computed)).toMatchObject({ unverified: true });
    expect((data(computed)['items'] as Array<{ code: string }>).map((i) => i.code)).toContain('FRC_DATA_UNVERIFIED');
    expect(code(execute(built.doc, 'compute_crack_growth', { caseId: 'nope' }))).toBe('FRC_CASE_NOT_FOUND');
    const narrowed = execute(built.doc, 'update_crack', {
      crackId: built.crackId,
      geometry: { kind: 'center_through', a: mm(2), W: mm(10), t: mm(2) },
    }).document;
    expect(code(execute(narrowed, 'compute_crack_growth', { caseId: built.caseId }))).toBe('FRC_K_SOLUTION_OUT_OF_RANGE');
    const oversized = execute(built.doc, 'create_crack_growth_case', {
      name: 'big',
      crackId: built.crackId,
      material: { recordId: 'dt_test', growthModelId: 'paris1', toughnessModelId: 'kc1' },
      histories: [{ historyId: built.historyId, scale: 1 }],
      growth: { aInitial: mm(90) },
    });
    expect(code(oversized)).toBe('FRC_K_SOLUTION_OUT_OF_RANGE');
  });

  it('selects the Kc entry nearest in thickness; edge cracks integrate with the Tada form', () => {
    const table = execute(materialDoc(), 'add_material_model', {
      material: 'dt_test',
      id: 'kt2',
      model: {
        kind: 'fracture_toughness',
        Kc: [
          { thickness: mm(1), value: { value: 80, unit: 'MPa*m^0.5' } },
          { thickness: mm(5), value: { value: 40, unit: 'MPa*m^0.5' } },
        ],
        state: 'thickness_table',
      },
      basis: 'company',
      source: { citation: 'test' },
    });
    const base = build({
      doc: table.document,
      geometry: { kind: 'edge_through', a: mm(5), b: mm(100), t: mm(2), form: 'tada', W: undefined },
    });
    const created = execute(base.doc, 'create_crack_growth_case', {
      name: 'e',
      crackId: base.crackId,
      material: { recordId: 'dt_test', growthModelId: 'paris1', toughnessModelId: 'kt2' },
      histories: [{ historyId: base.historyId, scale: 1 }],
      growth: { aInitial: mm(5) },
    });
    const result = data(execute(created.document, 'compute_crack_growth', { caseId: created.affected[0] }));
    expect(result['KcMPaSqrtM']).toBe(80);
    expect(result['lifeCycles']).toBeGreaterThan(0);
  });
});

function args(built: ReturnType<typeof build>): [CadDocument, string, { caseId: string }] {
  return [built.doc, 'compute_crack_growth', { caseId: built.caseId }];
}

describe('residual strength and inspection interval (VC-FRC-10..14, 20)', () => {
  it('VC-FRC-12: residual strength at 10 / 20 / 40 mm; VC-FRC-10 / 11 critical sizes', () => {
    const built = build();
    const result = data(
      execute(built.doc, 'compute_residual_strength', {
        caseId: built.caseId,
        sizes: [mm(10), mm(20), mm(40)],
        stress: { value: 150, unit: 'MPa' },
      }),
    );
    const expected = expectedValue(PACK, 'VC-FRC-12') as Record<
      string,
      { sigma_K_MPa: number; sigma_netyield_MPa: number; residualStrength_MPa: number; governing: string }
    >;
    const curve = result['curve'] as Array<{ sigmaKMPa: number; sigmaNetYieldMPa: number; residualMPa: number; governing: string }>;
    [0.01, 0.02, 0.04].forEach((a, i) => {
      const row = expected[`a=${a}`];
      expect(relative(curve[i]?.sigmaKMPa ?? 0, row?.sigma_K_MPa ?? 0)).toBeLessThan(1e-9);
      expect(relative(curve[i]?.residualMPa ?? 0, row?.residualStrength_MPa ?? 0)).toBeLessThan(1e-9);
      expect(curve[i]?.governing).toBe(row?.governing);
    });
    expect(relative(result['aCriticalM'] as number, expectedValue(PACK, 'VC-FRC-10') as number)).toBeLessThan(1e-9);
    expect(relative(result['aNetYieldM'] as number, expectedValue(PACK, 'VC-FRC-11') as number)).toBeLessThan(1e-12);
    expect(result['governing']).toBe('fracture');
  });

  it('the plan step with caseId works; the default curve spans aInitial to the K-solution limit; read-only', () => {
    const run = runPlanFile(RESIDUAL_PLAN);
    expect(run.steps.find((s) => s.command === 'compute_residual_strength')?.ok).toBe(true);
    const built = build();
    const result = execute(built.doc, 'compute_residual_strength', { caseId: built.caseId });
    expect((data(result)['curve'] as unknown[]).length).toBe(20);
    expect(result.document).toBe(built.doc);
    expect(result.summary).toContain('not approved');
  });

  it('refuses unknown cases, bad sizes, sizes beyond the K solution and a bad stress', () => {
    const built = build();
    expect(code(execute(built.doc, 'compute_residual_strength', { caseId: 'nope' }))).toBe('FRC_CASE_NOT_FOUND');
    expect(code(execute(built.doc, 'compute_residual_strength', { caseId: built.caseId, sizes: [mm(-1)] }))).toBe('FRC_PARAMS_INVALID');
    expect(code(execute(built.doc, 'compute_residual_strength', { caseId: built.caseId, sizes: [mm(90)] }))).toBe(
      'FRC_K_SOLUTION_OUT_OF_RANGE',
    );
    expect(code(execute(built.doc, 'compute_residual_strength', { caseId: built.caseId, stress: { value: 5, unit: 'mm' } }))).toBe(
      'FRC_PARAMS_INVALID',
    );
  });

  it('VC-FRC-14: interval = life / 2 = 46420.58 cycles with the explicit factor; threshold when its factor is set', () => {
    const run = runPlanFile(RESIDUAL_PLAN);
    const interval = stepData(run, 'compute_inspection_interval');
    expect(relative(interval['intervalCycles'] as number, expectedValue(PACK, 'VC-FRC-14') as number)).toBeLessThan(1e-6);
    expect(interval).toMatchObject({
      factors: { scatterInterval: { value: 2, defaulted: false } },
      reviewRequired: true,
      disposition: 'pending',
    });
    const built = build();
    const set = execute(built.doc, 'set_damage_tolerance_factors', {
      caseId: built.caseId,
      scatterInterval: { value: 2, source: 's' },
      scatterThreshold: { value: 3, source: 's' },
    }).document;
    const both = data(execute(set, 'compute_inspection_interval', { caseId: built.caseId }));
    expect(relative(both['thresholdCycles'] as number, (expectedValue(PACK, 'VC-FRC-13') as number) / 3)).toBeLessThan(1e-6);
  });

  it('VC-FRC-20: no factor, no detectable size, unknown case are refused with their codes', () => {
    const built = build();
    const unset = execute(built.doc, 'compute_inspection_interval', { caseId: built.caseId });
    expect(code(unset)).toBe('FRC_SCATTER_FACTOR_UNSET');
    expect(unset.document).toBe(built.doc);
    const noSize = build({
      growth: { aInitial: mm(5), aDetectable: undefined },
      extra: { factors: { scatterInterval: { value: 2, source: 's' } } },
    });
    expect(code(execute(noSize.doc, 'compute_inspection_interval', { caseId: noSize.caseId }))).toBe('FRC_DETECTABLE_SIZE_UNSET');
    expect(code(execute(built.doc, 'compute_inspection_interval', { caseId: 'nope' }))).toBe('FRC_CASE_NOT_FOUND');
  });

  it('check_damage_tolerance lists pending items; a complete case still needs a reviewer (VC-FRC-21)', () => {
    const run = runPlanFile(RESIDUAL_PLAN);
    const checked = stepData(run, 'check_damage_tolerance');
    expect((checked['items'] as Array<{ code: string }>).map((i) => i.code)).toEqual([
      'FRC_MARGINAL_BAND_UNSET',
      'FRC_DISPOSITION_PENDING',
    ]);
    expect(checked).toMatchObject({ status: 'warn', reviewRequired: true });
    const built = build();
    const unset = data(execute(built.doc, 'check_damage_tolerance', { caseId: built.caseId }));
    expect(unset['status']).toBe('fail');
    expect((unset['items'] as Array<{ code: string }>).map((i) => i.code)).toContain('FRC_SCATTER_FACTOR_UNSET');
    expect(code(execute(built.doc, 'check_damage_tolerance', { caseId: 'nope' }))).toBe('FRC_CASE_NOT_FOUND');
  });

  it('check_damage_tolerance reports initial-critical, missing detectable size, unresolved models and out-of-range sizes', () => {
    const critical = build({ geometry: { a: mm(40) }, growth: { aInitial: mm(40.9), aDetectable: undefined } });
    const items = (
      data(execute(critical.doc, 'check_damage_tolerance', { caseId: critical.caseId }))['items'] as Array<{ code: string }>
    ).map((i) => i.code);
    expect(items).toEqual(expect.arrayContaining(['FRC_INITIAL_CRITICAL', 'FRC_DETECTABLE_SIZE_UNSET']));
    const built = build();
    const broken = execute(built.doc, 'delete_crack', { crackId: built.crackId });
    expect(code(broken)).toBe('FRC_CRACK_IN_USE');
    const updated = execute(built.doc, 'update_crack', {
      crackId: built.crackId,
      geometry: { kind: 'center_through', a: mm(2), W: mm(10), t: mm(2) },
    }).document;
    expect(
      (data(execute(updated, 'check_damage_tolerance', { caseId: built.caseId }))['items'] as Array<{ code: string }>).map((i) => i.code),
    ).toContain('FRC_K_SOLUTION_OUT_OF_RANGE');
    const gone = {
      ...built.doc,
      analysis: { ...built.doc.analysis, durability: { ...built.doc.analysis?.durability, cracks: {}, crackOrder: [] } },
    } as CadDocument;
    expect(
      (data(execute(gone, 'check_damage_tolerance', { caseId: built.caseId }))['items'] as Array<{ code: string }>).map((i) => i.code),
    ).toContain('FRC_CRACK_NOT_FOUND');
  });
});
