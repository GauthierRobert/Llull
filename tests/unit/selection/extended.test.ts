import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { CadDocument } from '@core/model/types';
import { dataOf, expectedCase, inputs, PACK, run, step, syntheticDocument, withMaterial, workedDocument } from './fixtures';

interface Row {
  readonly material: string;
  readonly case: string;
  readonly value: number;
  readonly unit: string;
  readonly unverified: boolean;
  readonly unverifiedReasons: string[];
  readonly warnings: { code: string }[];
  readonly inputs: { property: string; value: number; basis: string; temperature?: { value: number; unit: string } }[];
}

interface Ranked {
  readonly material: string;
  readonly score: number;
  readonly objectives: Row[];
}

const syn = syntheticDocument();
const ids = inputs.synthetic.map((entry) => entry.id);
const codes = (result: ReturnType<typeof run>, key = 'warnings'): string[] =>
  (dataOf(result)[key] as { code: string }[]).map((entry) => entry.code);
const rankedOf = (result: ReturnType<typeof run>): Ranked[] => dataOf(result)['ranked'] as Ranked[];
const excludedOf = (result: ReturnType<typeof run>): { material: string; code: string; reason: string; missing?: string[] }[] =>
  dataOf(result)['excluded'] as { material: string; code: string; reason: string; missing?: string[] }[];

describe('user-defined index (VC-SEL-19)', () => {
  const user = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    index: 'user',
    exponents: { E: 0.5 },
    derivationNote: 'beam, square section, free side: m ~ rho / E^(1/2)',
    ...extra,
  });

  it('prod(P^a) / rho with E^(1/2) equals the beam stiffness index and carries the derivation note', () => {
    const result = run(syn, 'compare_materials', { materials: ids, objectives: [user()] });
    const ranked = rankedOf(result);
    const builtin = rankedOf(run(syn, 'compare_materials', { materials: ids, objectives: [{ index: 'beam_stiffness' }] }));
    expect(ranked.map((entry) => entry.material)).toEqual(builtin.map((entry) => entry.material));
    ranked.forEach((entry, k) => expect(entry.objectives[0]?.value).toBeCloseTo(builtin[k]?.objectives[0]?.value ?? Number.NaN, 12));
    expect(ranked[0]?.objectives[0]).toMatchObject({ case: 'user', unit: 'GPa^(0.5)/(Mg/m^3)' });
    expect((dataOf(result)['objectives'] as { derivationNote?: string }[])[0]?.derivationNote).toContain('m ~ rho');
  });

  it('a two-property user index multiplies the powers in base units', () => {
    const result = run(syn, 'compare_materials', { materials: ['syn_a'], objectives: [user({ exponents: { E: 0.5, Fty: 1 / 3 } })] });
    expect(rankedOf(result)[0]?.objectives[0]?.value).toBeCloseTo((Math.sqrt(70) * Math.cbrt(500)) / 2, 9);
  });

  it('VC-SEL-19: a missing / blank derivationNote, no exponent, density or an unknown property are refused (unchanged doc)', () => {
    const code = (objective: Record<string, unknown>): string | undefined =>
      run(syn, 'compare_materials', { materials: ids, objectives: [objective] }).error?.code;
    expect(code(user({ derivationNote: undefined }))).toBe(expectedCase('VC-SEL-19').value);
    expect(code(user({ derivationNote: '   ' }))).toBe('SEL_DERIVATION_NOTE_MISSING');
    expect(code(user({ exponents: {} }))).toBe('SEL_PARAMS_INVALID');
    expect(code(user({ exponents: { density: 1 } }))).toBe('SEL_PARAMS_INVALID');
    expect(code(user({ exponents: { nope: 1 } }))).toBe('SEL_PARAMS_INVALID');
    expect(code(user({ exponents: { E: 0 } }))).toBe('SEL_PARAMS_INVALID');
    const refused = run(syn, 'compare_materials', { materials: ids, objectives: [user({ derivationNote: undefined })] });
    expect(refused.error?.paths).toEqual(['objectives.0.derivationNote']);
    expect(refused.document).toBe(syn);
  });

  it('a candidate without a property of the index is excluded, not ranked', () => {
    const result = run(syn, 'compare_materials', { materials: ids, objectives: [user({ exponents: { Fcy: 1 } })] });
    expect(rankedOf(result)).toEqual([]);
    expect(codes(result)).toContain('SEL_NO_CANDIDATE');
  });
});

describe('material_chart_data (VC-SEL-18)', () => {
  const chart = (extra: Record<string, unknown> = {}): ReturnType<typeof run> =>
    run(syn, 'material_chart_data', { materials: ids, x: { property: 'density' }, y: { property: 'E' }, ...extra });

  it('points in base units, one per material, log axes', () => {
    const result = chart();
    const data = dataOf(result);
    expect(result.document).toBe(syn);
    const points = data['points'] as { material: string; x: number; y: number }[];
    expect(points.map((point) => point.material)).toEqual(ids);
    points.forEach((point, k) => {
      expect(point.x).toBeCloseTo(inputs.synthetic[k]?.densityGcm3 ?? Number.NaN, 12);
      expect(point.y).toBeCloseTo(inputs.synthetic[k]?.eGPa ?? Number.NaN, 12);
    });
    expect(data['axes']).toMatchObject({
      x: { property: 'density', unit: 'Mg/m^3', scale: 'log' },
      y: { property: 'E', unit: 'GPa', scale: 'log' },
    });
    expect(data['guides']).toEqual([]);
  });

  it('guide lines of the E-based cases have slope 1, 2, 3, 2 on log E against log rho and pass through the best candidate', () => {
    const pin = expectedCase('VC-SEL-18').value as Record<string, number>;
    const cases = Object.keys(pin);
    const guides = dataOf(chart({ guides: cases }))['guides'] as {
      case: string;
      slope: number;
      constant: number;
      through: string;
      line: [number, number][];
    }[];
    expect(guides.map((guide) => guide.case)).toEqual(cases);
    for (const guide of guides) {
      expect(Math.abs(guide.slope - (pin[guide.case] ?? Number.NaN))).toBeLessThanOrEqual(1e-12);
      const n = 1 / guide.slope;
      const [[x1, y1], [x2, y2]] = guide.line as [[number, number], [number, number]];
      expect(Math.pow(y1, n) / x1).toBeCloseTo(guide.constant, 9);
      expect(Math.pow(y2, n) / x2).toBeCloseTo(guide.constant, 9);
      expect(Math.log(y2 / y1) / Math.log(x2 / x1)).toBeCloseTo(guide.slope, 9);
    }
    expect(guides.find((guide) => guide.case === 'beam_stiffness')?.through).toBe('syn_d');
  });

  it('strength guides need their strength property on y; an index axis is evaluated; exclusions are listed', () => {
    const strength = chart({ y: { property: 'Fty' }, guides: ['beam_strength'] });
    expect((dataOf(strength)['guides'] as { slope: number }[])[0]?.slope).toBeCloseTo(1.5, 12);
    const indexAxis = run(syn, 'material_chart_data', { materials: ids, x: { property: 'density' }, y: { index: 'beam_stiffness' } });
    expect((dataOf(indexAxis)['points'] as { y: number }[])[0]?.y).toBeCloseTo(Math.sqrt(70) / 2, 9);
    const worked = run(workedDocument(), 'material_chart_data', {
      materials: ['aa7075_t6', 'cfrp_t300_5208_quasi_iso'],
      x: { property: 'density' },
      y: { property: 'E' },
    });
    expect(excludedOf(worked)).toEqual([expect.objectContaining({ material: 'cfrp_t300_5208_quasi_iso', code: 'SEL_PROPERTY_MISSING' })]);
    expect(codes(worked)).toEqual(expect.arrayContaining(['SEL_VALUE_UNVERIFIED', 'SEL_PROPERTY_MISSING']));
  });

  it('is pure and refuses bad axes, guides on the wrong axes and unknown materials (unchanged doc)', () => {
    const before = structuredClone(syn);
    execute(syn, 'material_chart_data', { materials: ids, x: { property: 'density' }, y: { property: 'E' }, guides: ['beam_stiffness'] });
    expect(syn).toEqual(before);
    const code = (extra: Record<string, unknown>): string | undefined => chart(extra).error?.code;
    expect(code({ x: { property: 'density', index: 'beam_stiffness' } })).toBe('SEL_PARAMS_INVALID');
    expect(code({ x: {} })).toBe('SEL_PARAMS_INVALID');
    expect(code({ x: { property: 'nope' } })).toBe('SEL_PARAMS_INVALID');
    expect(code({ y: { index: 'beam_strength' } })).toBe('SEL_PARAMS_INVALID');
    expect(code({ guides: ['beam_stiffness'], x: { property: 'E' } })).toBe('SEL_PARAMS_INVALID');
    expect(code({ guides: ['beam_strength'], y: { property: 'E' } })).toBe('SEL_PARAMS_INVALID');
    expect(code({ materials: ['nope'] })).toBe('SEL_MATERIAL_NOT_FOUND');
    expect(chart({ materials: { library: 'absent' } }).rejected).toBeUndefined();
  });
});

describe('composite candidates through a layup (VC-SEL-17)', () => {
  const clt = JSON.parse(readFileSync(path.join(PACK, '../../../aerospace/06-composites/validation/clt_reference.json'), 'utf8')) as {
    materials: Record<string, { E1: number; E2: number; G12: number; nu12: number; ply_thickness: number; source: string }>;
    analytic_checks: Record<string, { quasi_isotropic_Ex: number; quasi_isotropic_nuxy: number }>;
  };
  const lamina = clt.materials['T300_5208'];
  const lamDoc = (density?: number): CadDocument =>
    step(syn, 'create_lamina_material', {
      name: 'T300_5208',
      form: 'ud_tape',
      E1: lamina?.E1,
      E2: lamina?.E2,
      G12: lamina?.G12,
      nu12: lamina?.nu12,
      plyThickness: lamina?.ply_thickness,
      basis: 'mean',
      source: lamina?.source,
      ...(density === undefined ? {} : { density }),
    });
  const layups = { T300_5208: { laminate: '[0/+45/-45/90]s' } };
  /** A labelled TEST density (0.0016 g/mm^3 = 1.6 g/cm^3, not a sourced property): the pack leaves the CFRP density tbd (VC-SEL-14). */
  const TEST_DENSITY = 0.0016;

  it('the lamina is ranked through the laminate in-plane Ex (never E1), with SEL_ANISOTROPIC and the lamina basis', () => {
    const result = run(lamDoc(TEST_DENSITY), 'material_index', { materials: ['syn_a', 'T300_5208'], indices: ['beam_stiffness'], layups });
    const composite = (dataOf(result)['results'] as Row[]).find((row) => row.material === 'T300_5208');
    const eUsed = (expectedCase('VC-SEL-17') as unknown as { eUsedGPa: number }).eUsedGPa;
    const e = composite?.inputs.find((input) => input.property === 'E');
    expect(Math.abs((e?.value ?? Number.NaN) - eUsed)).toBeLessThan(1e-3);
    expect(Math.abs((e?.value ?? Number.NaN) - (clt.analytic_checks['T300_5208']?.quasi_isotropic_Ex ?? Number.NaN) / 1000)).toBeLessThan(
      1e-3,
    );
    expect(e?.value).toBeLessThan((lamina?.E1 ?? 0) / 1000 / 2);
    expect(composite?.warnings.map((entry) => entry.code)).toContain(expectedCase('VC-SEL-17').value);
    expect(e?.basis).toBe('laminate:mean');
    expect(composite?.unverified).toBe(true);
    expect(codes(result)).toContain('SEL_VALUE_UNVERIFIED');
  });

  it('without a density the lamina is excluded (VC-SEL-14), a strength index excludes a laminate, a lamina without layup is refused', () => {
    const noDensity = run(lamDoc(), 'material_index', { materials: ['T300_5208'], indices: ['beam_stiffness'], layups });
    expect(excludedOf(noDensity)).toEqual([expect.objectContaining({ code: 'SEL_PROPERTY_MISSING', missing: ['density'] })]);
    const strength = run(lamDoc(TEST_DENSITY), 'material_index', {
      materials: ['T300_5208'],
      indices: ['beam_strength'],
      strengthProperty: 'Fty',
      layups,
    });
    expect(excludedOf(strength)).toEqual([expect.objectContaining({ missing: ['Fty'] })]);
    const bare = run(lamDoc(TEST_DENSITY), 'compare_materials', { materials: ['T300_5208'], objectives: [{ index: 'beam_stiffness' }] });
    expect(bare.error).toMatchObject({ code: 'SEL_LAYUP_REQUIRED', ids: ['T300_5208'] });
    const stray = run(lamDoc(TEST_DENSITY), 'compare_materials', {
      materials: ['syn_a'],
      objectives: [{ index: 'beam_stiffness' }],
      layups,
    });
    expect(stray.error?.code).toBe('SEL_PARAMS_INVALID');
  });

  it('compare_materials ranks the lamina beside a metal; a strength constraint excludes it (a laminate has no scalar strength)', () => {
    const doc = lamDoc(TEST_DENSITY);
    const params = { materials: ['syn_a', 'T300_5208'], objectives: [{ index: 'beam_stiffness' }], layups };
    expect(
      rankedOf(run(doc, 'compare_materials', params))
        .map((entry) => entry.material)
        .sort(),
    ).toEqual(['T300_5208', 'syn_a']);
    const constrained = run(doc, 'compare_materials', { ...params, constraints: [{ property: 'Fty', min: { value: 100, unit: 'MPa' } }] });
    expect(excludedOf(constrained)).toEqual([expect.objectContaining({ material: 'T300_5208' })]);
  });

  it('a layup with a bad stacking string or an unknown lamina excludes the candidate with the 06 / SEL code', () => {
    const doc = lamDoc(TEST_DENSITY);
    const bad = run(doc, 'material_index', {
      materials: ['T300_5208'],
      indices: ['beam_stiffness'],
      layups: { T300_5208: { laminate: '[0/zz]' } },
    });
    expect(excludedOf(bad)).toEqual([expect.objectContaining({ code: 'CMP_NOTATION_PARSE', missing: ['E'] })]);
    const ghost = run(doc, 'material_index', {
      materials: ['syn_a'],
      indices: ['beam_stiffness'],
      layups: { syn_a: { laminate: '[0/90]s', lamina: 'ghost' } },
    });
    expect(excludedOf(ghost)).toEqual([expect.objectContaining({ code: 'SEL_MATERIAL_NOT_FOUND' })]);
  });
});

describe('temperature selection through PHY-01 (VC-SEL-20) and the service-temperature constraint (VC-SEL-04)', () => {
  const hot = withMaterial(syn, 'hot', [
    { property: 'density', value: 2.7, unit: 'g/cm^3', basis: 'company', citation: 'test fixture' },
    { property: 'Fty', value: 300, unit: 'MPa', basis: 'company', citation: 'test fixture' },
  ]);
  const withTable = step(hot, 'set_material_property', {
    material: 'hot',
    property: 'E',
    unit: 'GPa',
    basis: 'company',
    temperature: {
      mode: 'absolute',
      temperatureUnit: 'degC',
      points: [
        [20, 70],
        [200, 60],
      ],
    },
    source: { citation: 'test fixture: E(T) table, 20-200 degC' },
  });
  const index = (temperature: Record<string, unknown>): ReturnType<typeof run> =>
    run(withTable, 'material_index', { materials: ['hot'], indices: ['beam_stiffness'], temperature });

  it('inside the table E is interpolated and the density read at 20 degC is flagged; outside it the PHY-01 code is forwarded, nothing is imputed', () => {
    const inside = dataOf(index({ value: 100, unit: 'degC' }));
    const row = (inside['results'] as Row[])[0];
    const e = row?.inputs.find((input) => input.property === 'E');
    expect(e?.value).toBeCloseTo(70 - (10 * 80) / 180, 9);
    expect(e?.temperature).toEqual({ value: 100, unit: 'degC' });
    expect(row?.unverifiedReasons.join(' ')).toContain('density read at 20 degC');
    const outside = index({ value: 300, unit: 'degC' });
    expect(dataOf(outside)['results']).toEqual([]);
    expect(excludedOf(outside)).toEqual([
      expect.objectContaining({ code: (expectedCase('VC-SEL-20').value as { excludedCode: string }).excludedCode, missing: ['E'] }),
    ]);
    expect((expectedCase('VC-SEL-20').value as { imputed: boolean }).imputed).toBe(false);
  });

  it('a constant-only E is not extended to another temperature (excluded, SEL_PROPERTY_MISSING)', () => {
    const result = run(syn, 'material_index', {
      materials: ['syn_a'],
      indices: ['beam_stiffness'],
      temperature: { value: 100, unit: 'degC' },
    });
    expect(excludedOf(result)).toEqual([
      expect.objectContaining({ code: 'SEL_PROPERTY_MISSING', missing: ['E'], reason: expect.stringContaining('no temperature law') }),
    ]);
  });

  it('compare_materials at a temperature uses the same resolution; a temperature outside the table excludes the candidate', () => {
    const at = (value: number): string[] =>
      rankedOf(
        run(withTable, 'compare_materials', {
          materials: ['hot'],
          objectives: [{ index: 'beam_stiffness' }],
          temperature: { value, unit: 'degC' },
        }),
      ).map((entry) => entry.material);
    expect(at(100)).toEqual(['hot']);
    expect(at(300)).toEqual([]);
  });

  it('VC-SEL-04: Fty >= 550 MPa and service temperature >= 110 degC keep syn_b, syn_c, syn_d; the failures list the values', () => {
    const result = run(syn, 'compare_materials', {
      materials: ids,
      objectives: [{ index: 'beam_stiffness' }],
      constraints: [
        { property: 'Fty', min: { value: 550, unit: 'MPa' } },
        { property: 'maxServiceTemperature', min: { value: 110, unit: 'degC' } },
      ],
    });
    const failed = dataOf(result)['failed'] as { material: string; constraint: string; value: number; unit: string }[];
    expect(
      rankedOf(result)
        .map((entry) => entry.material)
        .sort(),
    ).toEqual(expectedCase('VC-SEL-04').value);
    expect(failed.find((entry) => entry.material === 'syn_e' && entry.constraint.startsWith('maxServiceTemperature'))).toMatchObject({
      value: 100,
      unit: 'degC',
    });
    expect(failed.map((entry) => entry.material).sort()).toEqual(['syn_a', 'syn_e', 'syn_e']);
  });
});
