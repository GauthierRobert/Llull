/** thermal_stress_check (PHY-04 5.5): VC-TMC-01, 03, 04, 05, 07, 08, 09 and the CSV references, units, failure codes, purity. */
import { describe, expect, it } from 'vitest';
import { expectCase, packCase } from '../benchmarkCases';
import { PACK, csvRows, dataOf, emptyDoc, run } from './thermomechFixtures';

type Q = { value: number; unit: string };
const q = (value: number, unit: string): Q => ({ value, unit });

interface CheckData {
  check: string;
  results?: Record<string, Q>;
  rows?: Record<string, number>[];
  units?: Record<string, string>;
  formulas: string[];
  assumptions: string[];
  defaults?: string[];
  inputs: Record<string, Q>;
  reviewRequired: boolean;
}

const check = (name: string, inputs: Record<string, Q>, extra: Record<string, unknown> = {}): CheckData =>
  dataOf<CheckData>(run(emptyDoc(), 'thermal_stress_check', { check: name, inputs, ...extra }));
const value = (data: CheckData, key: string): number => data.results?.[key]?.value ?? Number.NaN;
const close = (actual: number, expected: number, digits = 12): void => {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(Math.abs(expected) * 10 ** -digits + 1e-300);
};

const RESTRAINED = { E: q(210000, 'MPa'), alpha: q(1.2e-5, '1/K'), dT: q(100, 'K'), nu: q(0.3, '1') };

describe('thermal_stress_check: restrained and inclusion', () => {
  it('VC-TMC-01.a-c', () => {
    const data = check('restrained', RESTRAINED);
    expectCase(PACK, 'VC-TMC-01.a', value(data, 'uniaxial'));
    expectCase(PACK, 'VC-TMC-01.b', value(data, 'biaxial'));
    expectCase(PACK, 'VC-TMC-01.c', value(data, 'triaxial'));
    expect(data.results?.['uniaxial']?.unit).toBe('MPa');
    expect(data.reviewRequired).toBe(true);
    expect(data.formulas).toHaveLength(3);
  });

  it('converts units and treats a degC difference as a difference', () => {
    const data = check('restrained', { E: q(210, 'GPa'), alpha: q(1.2e-5, '1/K'), dT: q(100, 'degC'), nu: q(0.3, '1') });
    close(value(data, 'uniaxial'), -252);
    expect(data.inputs['E']).toEqual({ value: 210000, unit: 'MPa' });
    expect(data.inputs['dT']).toEqual({ value: 100, unit: 'K' });
  });

  it('VC-TMC-03.a-c: NAFEMS T1 closed form', () => {
    const inputs = { E: q(100000, 'MPa'), alpha: q(1e-3, '1/K'), dT: q(1, 'K'), a: q(1, 'mm') };
    const atInterface = check('inclusion', inputs);
    expectCase(PACK, 'VC-TMC-03.a', value(atInterface, 'outsideHoop'));
    expect(atInterface.defaults).toEqual(['r = a (just outside the inclusion)']);
    expectCase(PACK, 'VC-TMC-03.b', value(check('inclusion', { ...inputs, r: q(1.005, 'mm') }), 'outsideHoop'));
    expectCase(PACK, 'VC-TMC-03.c', value(atInterface, 'insideHoop'));
    close(value(atInterface, 'insideRadial'), value(atInterface, 'insideHoop'));
    close(value(atInterface, 'outsideRadial'), -value(atInterface, 'outsideHoop'));
  });
});

describe('thermal_stress_check: bimetal, gradient beam', () => {
  const bimetal = {
    t1: q(0.5, 'mm'),
    t2: q(0.5, 'mm'),
    E1: q(200000, 'MPa'),
    E2: q(100000, 'MPa'),
    alpha1: q(1.2e-5, '1/K'),
    alpha2: q(1.9e-5, '1/K'),
    dT: q(100, 'K'),
    L: q(50, 'mm'),
  };
  it('VC-TMC-04.a-b with the equilibrium cross-check', () => {
    const data = check('bimetal', bimetal);
    expectCase(PACK, 'VC-TMC-04.a', value(data, 'curvature'));
    expectCase(PACK, 'VC-TMC-04.b', value(data, 'cantileverTip'));
    const expected = packCase(PACK, 'VC-TMC-04.a') as unknown as { equilibriumSolve: number };
    close(value(data, 'curvatureEquilibrium'), expected.equilibriumSolve, 10);
    const withoutLength = Object.fromEntries(Object.entries(bimetal).filter(([key]) => key !== 'L'));
    expect(check('bimetal', withoutLength).results?.['cantileverTip']).toBeUndefined();
  });

  it('VC-TMC-08.a-d: through-thickness gradient', () => {
    const data = check('gradient_beam', { alpha: q(2.3e-5, '1/K'), dT: q(20, 'K'), h: q(5, 'mm'), L: q(0.5, 'm') });
    expectCase(PACK, 'VC-TMC-08.a', value(data, 'curvature'));
    expectCase(PACK, 'VC-TMC-08.b', value(data, 'midspanBow'));
    expectCase(PACK, 'VC-TMC-08.c', value(data, 'cantileverTip'));
    expectCase(PACK, 'VC-TMC-08.d', value(data, 'stress'));
  });
});

describe('thermal_stress_check: thick cylinder (VC-TMC-05)', () => {
  const cylinder = { E: q(200000, 'MPa'), nu: q(0.3, '1'), alpha: q(1.2e-5, '1/K'), a: q(10, 'mm'), b: q(20, 'mm'), dT: q(100, 'K') };
  it('05.a-c at the bore and outer surface (default radii) with the quadrature and log-form cross-checks', () => {
    const data = check('thick_cylinder', cylinder);
    expect(data.defaults).toEqual(['radii = bore and outer surface']);
    const [bore, outer] = data.rows ?? [];
    expectCase(PACK, 'VC-TMC-05.a', bore?.['sigmaHoop'] ?? Number.NaN);
    expectCase(PACK, 'VC-TMC-05.b', outer?.['sigmaHoop'] ?? Number.NaN);
    expectCase(PACK, 'VC-TMC-05.c', bore?.['sigmaAxial'] ?? Number.NaN);
    const a = packCase(PACK, 'VC-TMC-05.a') as unknown as { crossChecks: { classicLogForm: number; quadrature: number } };
    close(bore?.['sigmaHoopClassic'] ?? Number.NaN, a.crossChecks.classicLogForm, 11);
    close(bore?.['sigmaHoopQuadrature'] ?? Number.NaN, a.crossChecks.quadrature, 11);
    const b = packCase(PACK, 'VC-TMC-05.b') as unknown as { crossChecks: { classicLogForm: number; quadrature: number } };
    close(outer?.['sigmaHoopClassic'] ?? Number.NaN, b.crossChecks.classicLogForm, 11);
    expect(bore?.['sigmaRadial']).toBeCloseTo(0, 9);
    expect(data.units?.['sigmaHoop']).toBe('MPa');
  });

  it('reproduces thick_cylinder_profile.csv at the 11 radii', () => {
    const csv = csvRows('thick_cylinder_profile.csv');
    const data = check('thick_cylinder', cylinder, { points: csv.map((row) => q(Number(row['r_mm']), 'mm')) });
    expect(data.rows).toHaveLength(11);
    csv.forEach((row, i) => {
      const got = data.rows?.[i] ?? {};
      for (const [column, key] of [
        ['T_K_above_outer', 'temperature'],
        ['sigma_r_MPa', 'sigmaRadial'],
        ['sigma_theta_MPa', 'sigmaHoop'],
        ['sigma_z_MPa', 'sigmaAxial'],
        ['sigma_theta_quadrature_MPa', 'sigmaHoopQuadrature'],
      ] as const) {
        const expected = Number(row[column]);
        expect(Math.abs((got[key] ?? Number.NaN) - expected), `${column} at r=${row['r_mm']}`).toBeLessThanOrEqual(
          Math.abs(expected) * 1e-8 + 1e-8,
        );
      }
    });
  });

  it('accepts a single radius `r` in any length unit', () => {
    const data = check('thick_cylinder', { ...cylinder, r: q(1.5, 'cm') });
    expect(data.rows).toHaveLength(1);
    expect(data.rows?.[0]?.['r']).toBeCloseTo(15, 12);
    expect(data.defaults).toBeUndefined();
  });
});

describe('thermal_stress_check: CTE conversion (VC-TMC-07)', () => {
  const law = { referenceTemperature: q(20, 'degC'), alpha0: q(2.2e-5, '1/K'), alpha1: q(1e-8, '1/K^2'), lawTemperature: q(20, 'degC') };
  const temperatures = [-55, 0, 50, 85, 120, 200];

  it('07.a-c and cte_conversion.csv (reference 20 degC and re-referenced to 0 degC)', () => {
    const data = check('cte_secant', { ...law, rereferenceTo: q(0, 'degC') }, { points: temperatures.map((T) => q(T, 'degC')) });
    const rows = data.rows ?? [];
    csvRows('cte_conversion.csv').forEach((csv, i) => {
      const row = rows[i] ?? {};
      close(row['alphaInstantaneous'] ?? Number.NaN, Number(csv['alpha_instantaneous_per_K']), 8);
      close(row['alphaSecant'] ?? Number.NaN, Number(csv['alpha_secant_ref20_per_K']), 8);
      close(row['alphaSecantRereferenced'] ?? Number.NaN, Number(csv['alpha_secant_ref0_per_K']), 8);
      close(row['thermalStrainFromReference'] ?? Number.NaN, Number(csv['thermal_strain_from_20']), 8);
      expect(row['T']).toBe(temperatures[i]);
    });
    const at120 = rows[4] ?? {};
    expectCase(PACK, 'VC-TMC-07.a', at120['alphaSecant'] ?? Number.NaN);
    expectCase(PACK, 'VC-TMC-07.b', at120['alphaSecantRereferenced'] ?? Number.NaN);
    expectCase(PACK, 'VC-TMC-07.c', at120['thermalStrainFromReference'] ?? Number.NaN);
    expect(data.units?.['T']).toBe('degC');
  });

  it('thermal strain between two temperatures does not depend on the reference (re-referenced to 0 degC)', () => {
    const data = check('cte_secant', { ...law, rereferenceTo: q(0, 'degC') }, { points: [q(20, 'degC'), q(120, 'degC')] });
    const [low, high] = data.rows ?? [];
    const strain = (high?.['alphaSecantRereferenced'] ?? 0) * 120 - (low?.['alphaSecantRereferenced'] ?? 0) * 20;
    const reference = packCase(PACK, 'VC-TMC-07.c') as unknown as { check_ref0: number };
    close(strain, reference.check_ref0, 11);
    expectCase(PACK, 'VC-TMC-07.c', strain);
  });

  it('integrates an instantaneous table exactly and refuses points outside it', () => {
    const table = [
      { T: q(0, 'degC'), alpha: q(2.18e-5, '1/K') },
      { T: q(100, 'degC'), alpha: q(2.28e-5, '1/K') },
      { T: q(200, 'degC'), alpha: q(2.38e-5, '1/K') },
    ];
    const reference = { referenceTemperature: law.referenceTemperature };
    const data = check('cte_secant', reference, { table, points: [q(120, 'degC'), q(20, 'degC')] });
    close(data.rows?.[0]?.['alphaSecant'] ?? Number.NaN, 2.25e-5, 12);
    close(data.rows?.[1]?.['alphaSecant'] ?? Number.NaN, 2.2e-5, 12);
    const outside = run(emptyDoc(), 'thermal_stress_check', { check: 'cte_secant', inputs: reference, table, points: [q(300, 'degC')] });
    expect(outside.error?.code).toBe('TMC_CHECK_INPUT_INVALID');
  });
});

describe('thermal_stress_check: shrink fit (VC-TMC-09)', () => {
  const inputs = {
    b: q(10, 'mm'),
    c: q(20, 'mm'),
    E_hub: q(70000, 'MPa'),
    nu_hub: q(0.33, '1'),
    E_shaft: q(200, 'GPa'),
    nu_shaft: q(0.3, '1'),
    interferenceMax: q(0.035, 'mm'),
    interferenceMin: q(0.001, 'mm'),
  };
  const thermal = {
    alpha_hub: q(23e-6, '1/K'),
    alpha_shaft: q(11.5e-6, '1/K'),
    temperature: q(85, 'degC'),
    specTemperature: q(20, 'degC'),
  };

  it('09.a: contact pressure at 20 degC; interference range at 85 degC by the nominal-diameter linearisation', () => {
    const data = check('shrink_fit', { ...inputs, ...thermal });
    expectCase(PACK, 'VC-TMC-09.a', value(data, 'contactPressureMax'));
    close(value(data, 'interferenceMaxAtTemperature'), 0.035 - 20 * 11.5e-6 * 65, 12);
    close(value(data, 'interferenceMinAtTemperature'), 0.001 - 20 * 11.5e-6 * 65, 12);
    close(value(data, 'hubBoreHoopStressMax'), (value(data, 'contactPressureMax') * 500) / 300, 12);
    expect(value(data, 'contactPressureMin')).toBeGreaterThan(0);
    expect(value(data, 'contactPressureMaxAtTemperature')).toBeLessThan(value(data, 'contactPressureMax'));
  });

  it('zero pressure for a clearance and without the thermal group', () => {
    const data = check('shrink_fit', { ...inputs, interferenceMax: q(-0.01, 'mm') });
    expect(value(data, 'contactPressureMax')).toBe(0);
    expect(data.results?.['interferenceMaxAtTemperature']).toBeUndefined();
  });
});

describe('thermal_stress_check: failure paths and purity', () => {
  const codeOf = (name: string, inputs: Record<string, Q>, extra: Record<string, unknown> = {}): string | undefined => {
    const doc = emptyDoc();
    const result = run(doc, 'thermal_stress_check', { check: name, inputs, ...extra });
    expect(result.document).toBe(doc);
    expect(result.affected).toEqual([]);
    expect(result.rejected).toBe(true);
    expect(result.error?.remediation.length).toBeGreaterThan(0);
    return result.error?.code;
  };

  it('missing, unknown, wrong-dimension and invalid inputs have stable codes', () => {
    expect(codeOf('restrained', { E: RESTRAINED.E })).toBe('TMC_CHECK_INPUT_MISSING');
    expect(codeOf('restrained', { ...RESTRAINED, typo: q(1, 'K') })).toBe('TMC_CHECK_INPUT_UNKNOWN');
    expect(codeOf('restrained', { ...RESTRAINED, E: q(210000, 'mm') })).toBe('MAT_UNIT_DIMENSION');
    expect(codeOf('restrained', { ...RESTRAINED, dT: q(100, 'MPa') })).toBe('MAT_UNIT_DIMENSION');
    expect(codeOf('restrained', { ...RESTRAINED, E: q(1, 'banana') })).toBe('MAT_UNIT_INVALID');
    expect(codeOf('restrained', { ...RESTRAINED, nu: q(0.5, '1') })).toBe('TMC_CHECK_INPUT_INVALID');
    expect(codeOf('restrained', { ...RESTRAINED, E: q(1e308, 'GPa') })).toBe('TMC_CHECK_INPUT_INVALID');
    const inclusion = { E: q(1e5, 'MPa'), alpha: q(1e-3, '1/K'), dT: q(1, 'K'), a: q(1, 'mm') };
    expect(codeOf('inclusion', { ...inclusion, r: q(0.5, 'mm') })).toBe('TMC_CHECK_INPUT_INVALID');
    const cylinder = { E: q(2e5, 'MPa'), nu: q(0.3, '1'), alpha: q(1e-5, '1/K'), a: q(10, 'mm'), b: q(5, 'mm'), dT: q(1, 'K') };
    expect(codeOf('thick_cylinder', cylinder)).toBe('TMC_CHECK_INPUT_INVALID');
    expect(codeOf('thick_cylinder', { ...cylinder, b: q(20, 'mm') }, { points: [q(30, 'mm')] })).toBe('TMC_CHECK_INPUT_INVALID');
    expect(codeOf('thick_cylinder', { ...cylinder, b: q(20, 'mm') }, { points: [q(30, 'K')] })).toBe('MAT_UNIT_DIMENSION');
    expect(
      codeOf('bimetal', {
        t1: q(0, 'mm'),
        t2: q(1, 'mm'),
        E1: q(1, 'MPa'),
        E2: q(1, 'MPa'),
        alpha1: q(1, '1/K'),
        alpha2: q(2, '1/K'),
        dT: q(1, 'K'),
      }),
    ).toBe('TMC_CHECK_INPUT_INVALID');
    expect(codeOf('gradient_beam', { alpha: q(1e-5, '1/K'), dT: q(1, 'K'), h: q(0, 'mm'), L: q(1, 'mm') })).toBe('TMC_CHECK_INPUT_INVALID');
    const shrink = {
      b: q(10, 'mm'),
      c: q(5, 'mm'),
      E_hub: q(1, 'MPa'),
      nu_hub: q(0.3, '1'),
      E_shaft: q(1, 'MPa'),
      nu_shaft: q(0.3, '1'),
      interferenceMax: q(0.01, 'mm'),
    };
    expect(codeOf('shrink_fit', shrink)).toBe('TMC_CHECK_INPUT_INVALID');
    expect(codeOf('shrink_fit', { ...shrink, c: q(20, 'mm'), alpha_hub: q(1e-5, '1/K') })).toBe('TMC_CHECK_INPUT_INVALID');
    const cte = { referenceTemperature: q(20, 'degC') };
    expect(codeOf('cte_secant', cte, { points: [q(50, 'degC')] })).toBe('TMC_CHECK_INPUT_INVALID');
    expect(codeOf('cte_secant', { ...cte, alpha0: q(2e-5, '1/K'), alpha1: q(0, '1/K^2'), lawTemperature: q(20, 'degC') })).toBe(
      'TMC_CHECK_INPUT_INVALID',
    );
    expect(codeOf('cte_secant', cte, { points: [q(50, 'mm')] })).toBe('MAT_UNIT_DIMENSION');
    expect(codeOf('cte_secant', cte, { points: [q(50, 'degC')], table: [{ T: q(0, 'mm'), alpha: q(1e-5, '1/K') }] })).toBe(
      'MAT_UNIT_DIMENSION',
    );
    expect(codeOf('cte_secant', cte, { points: [q(50, 'degC')], table: [{ T: q(0, 'degC'), alpha: q(1, 'mm') }] })).toBe(
      'MAT_UNIT_DIMENSION',
    );
    expect(codeOf('cte_secant', cte, { points: [q(50, 'degC')], table: [{ T: q(0, 'degC'), alpha: q(1e-5, '1/K') }] })).toBe(
      'TMC_CHECK_INPUT_INVALID',
    );
  });

  it('is pure and read-only; unknown check names are rejected by the schema', () => {
    const doc = emptyDoc();
    const snapshot = structuredClone(doc);
    const result = run(doc, 'thermal_stress_check', { check: 'restrained', inputs: RESTRAINED });
    expect(doc).toEqual(snapshot);
    expect(result.document).toBe(doc);
    expect(result.summary).toContain('uniaxial');
    expect(run(doc, 'thermal_stress_check', { check: 'nope', inputs: {} }).rejected).toBe(true);
  });
});
