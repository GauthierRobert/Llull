/** VC-MATL-10, 11, 12: Prony + shift, Norton / Garofalo creep and Johnson-Cook kernels; their use in the driver. */
import { describe, expect, it } from 'vitest';
import { garofaloRate, nortonCreepStrain } from '@core/model/materialLaws/creep';
import { johnsonCookFlowStress } from '@core/model/materialLaws/hardening';
import { arrheniusLnShift, pronyRatio, pronyRecursion, wlfLog10Shift } from '@core/model/materialLaws/viscoelastic';
import { isLawFailure } from '@core/model/materialLaws/resolve';
import { GAS_CONSTANT } from '@core/model/propertyForms';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { expectCase } from '../benchmarkCases';
import { GPa, MPa, ONE, PACK, addModel, codeOf, defineSet, pointResponse, sig12, withMaterial } from './materialFixtures';

describe('Prony series and shift (VC-MATL-10)', () => {
  it('relaxes G(t)/G0 for the synthetic series', () => {
    for (const t of [0, 0.1, 1, 10, 100]) expectCase(PACK, `VC-MATL-10/prony/t=${t}s`, sig12(pronyRatio([0.3, 0.2], [0.1, 10], t)), 'MPa');
  });

  it('shifts with WLF above Tg and refuses below it', () => {
    for (const T of [373, 383, 423]) expectCase(PACK, `VC-MATL-10/wlf/T=${T}K`, sig12(wlfLog10Shift(17.44, 51.6, 373, true, T) as number));
    const below = wlfLog10Shift(17.44, 51.6, 373, true, 360);
    expect(isLawFailure(below) ? below.code : 'accepted').toBe('MATL_SHIFT_OUT_OF_RANGE');
    expectCase(PACK, 'VC-MATL-10/wlf/T=360K', isLawFailure(below) ? below.code : 'accepted');
    expect(isLawFailure(wlfLog10Shift(17.44, 51.6, 373, false, 300))).toBe(true);
    expect(wlfLog10Shift(17.44, 51.6, 373, false, 360)).toBeGreaterThan(0);
  });

  it('shifts with Arrhenius: faster relaxation when hot', () => {
    expect(arrheniusLnShift(50000, 300, 300)).toBe(0);
    expect(arrheniusLnShift(50000, 300, 350)).toBeCloseTo((50000 / GAS_CONSTANT) * (1 / 350 - 1 / 300), 12);
    expect(arrheniusLnShift(50000, 300, 350)).toBeLessThan(0);
  });

  it('the exponential recursion is exact for a held strain', () => {
    expect(pronyRecursion(1, 0, 0, 5)).toBe(1);
    expect(pronyRecursion(1, 0, 2, 5)).toBeCloseTo(Math.exp(-0.4), 14);
    expect(pronyRecursion(0, 1, 1e-15, 5)).toBeCloseTo(1, 12);
  });
});

describe('Prony viscoelasticity in the driver', () => {
  const E = 3;
  const nu = 0.3;
  const G0 = E / (2 * (1 + nu));
  const build = (viscoelastic: Record<string, unknown>): CadDocument => {
    let doc = withMaterial(createEmptyDocument(), 'poly');
    doc = addModel(doc, 'poly', 'elastic', { kind: 'elastic_isotropic', E: MPa(E), nu: ONE(nu) });
    doc = addModel(doc, 'poly', 'visco', viscoelastic);
    return defineSet(doc, 'poly', { id: 's', elastic: 'elastic', viscoelastic: 'visco' }, true);
  };
  const series = {
    shear: [
      { g: 0.3, tau: { value: 0.1, unit: 's' } },
      { g: 0.2, tau: { value: 10, unit: 's' } },
    ],
  };
  const relax = (doc: CadDocument, hold: number, temperature?: number): number => {
    const T = temperature === undefined ? {} : { temperature: { value: temperature, unit: 'K' } };
    const data = pointResponse(doc, {
      material: 'poly',
      kinematics: 'small',
      steps: [
        { increments: 1, duration: { value: 1e-9, unit: 's' }, control: { xy: { strain: 0.01 } }, ...T },
        { increments: 50, duration: { value: hold, unit: 's' }, control: { xy: { strain: 0.01 } }, ...T },
      ],
    });
    return (data.rows[1]?.stress[3] ?? Number.NaN) / (G0 * 0.01);
  };

  it('relaxes the shear stress like the Prony series of the model', () => {
    const doc = build({ kind: 'visco_prony', ...series });
    for (const t of [0.1, 1, 10, 100]) expect(relax(doc, t)).toBeCloseTo(pronyRatio([0.3, 0.2], [0.1, 10], t), 6);
  });

  it('applies the WLF shift at the step temperature and refuses below Tg', () => {
    const doc = build({
      kind: 'visco_prony',
      ...series,
      shift: {
        kind: 'wlf',
        C1: 17.44,
        C2: { value: 51.6, unit: 'K' },
        referenceTemperature: { value: 373, unit: 'K' },
        referenceIsTg: true,
      },
    });
    const aT = 10 ** (wlfLog10Shift(17.44, 51.6, 373, true, 383) as number);
    expect(relax(doc, 1e-3, 383)).toBeCloseTo(pronyRatio([0.3, 0.2], [0.1, 10], 1e-3 / aT), 6);
    const params = {
      material: 'poly',
      kinematics: 'small',
      steps: [{ increments: 1, temperature: { value: 360, unit: 'K' }, control: { xy: { strain: 0.01 } } }],
    };
    expect(codeOf(doc, 'material_point_response', params)).toBe('MATL_SHIFT_OUT_OF_RANGE');
    expect(codeOf(doc, 'material_point_response', { ...params, steps: [{ increments: 1, control: { xy: { strain: 0.01 } } }] })).toBe(
      'PROP_VARIABLE_MISSING',
    );
    const arrhenius = build({
      kind: 'visco_prony',
      ...series,
      shift: { kind: 'arrhenius', activationEnergy: { value: 50000, unit: 'J/mol' }, referenceTemperature: { value: 300, unit: 'K' } },
    });
    expect(relax(arrhenius, 1e-2, 350)).toBeCloseTo(
      pronyRatio([0.3, 0.2], [0.1, 10], 1e-2 / Math.exp(arrheniusLnShift(50000, 300, 350))),
      6,
    );
  });

  it('relaxes the bulk response with a bulk series', () => {
    const doc = build({
      kind: 'visco_prony',
      shear: [{ g: 0.3, tau: { value: 1, unit: 's' } }],
      bulk: [{ k: 0.4, tau: { value: 2, unit: 's' } }],
    });
    const K = E / (3 * (1 - 2 * nu));
    const data = pointResponse(doc, {
      material: 'poly',
      kinematics: 'small',
      steps: [
        {
          increments: 1,
          duration: { value: 1e-9, unit: 's' },
          control: { xx: { strain: 0.001 }, yy: { strain: 0.001 }, zz: { strain: 0.001 } },
        },
        {
          increments: 40,
          duration: { value: 3, unit: 's' },
          control: { xx: { strain: 0.001 }, yy: { strain: 0.001 }, zz: { strain: 0.001 } },
        },
      ],
    });
    const pressure = data.rows[1]?.stress[0] ?? Number.NaN;
    expect(pressure / (K * 3 * 0.001)).toBeCloseTo(pronyRatio([0.4], [2], 3), 6);
    expect(data.rows[1]?.stress[3]).toBe(0);
  });

  it('refuses invalid series (MATL_PRONY_INVALID)', () => {
    const doc = withMaterial(createEmptyDocument(), 'poly');
    const add = (model: Record<string, unknown>): string =>
      codeOf(doc, 'add_material_model', {
        material: 'poly',
        id: 'v',
        model: { kind: 'visco_prony', ...model },
        basis: 'typical',
        source: { citation: 'x' },
      });
    expect(
      add({
        shear: [
          { g: 0.6, tau: { value: 1, unit: 's' } },
          { g: 0.5, tau: { value: 2, unit: 's' } },
        ],
      }),
    ).toBe('MATL_PRONY_INVALID');
    expect(add({ shear: [{ g: -0.1, tau: { value: 1, unit: 's' } }] })).toBe('MATL_PRONY_INVALID');
    expect(add({ shear: [{ g: 0.1, tau: { value: 0, unit: 's' } }] })).toBe('MATL_PRONY_INVALID');
    expect(add({ shear: [] })).toBe('MATL_PRONY_INVALID');
    expect(add({ shear: [{ g: 0.1, tau: { value: 1, unit: 'K' } }] })).toBe('MATL_LAW_PARAMS_INVALID');
    expect(
      add({
        shear: [{ g: 0.1, tau: { value: 1, unit: 's' } }],
        shift: { kind: 'wlf', C1: 17, C2: { value: -5, unit: 'K' }, referenceTemperature: { value: 373, unit: 'K' }, referenceIsTg: true },
      }),
    ).toBe('MATL_LAW_PARAMS_INVALID');
    expect(
      add({
        shear: [{ g: 0.1, tau: { value: 1, unit: 's' } }],
        shift: { kind: 'arrhenius', activationEnergy: { value: 1, unit: 'K' }, referenceTemperature: { value: 300, unit: 'K' } },
      }),
    ).toBe('MATL_LAW_PARAMS_INVALID');
    expect(add({ shear: [{ g: 0.1, tau: { value: 1, unit: 's' } }] })).toBe('accepted');
  });
});

describe('creep (VC-MATL-11)', () => {
  it('integrates Norton at constant stress', () => {
    for (const m of [0, -0.5])
      expectCase(PACK, `VC-MATL-11/norton/m=${m.toFixed(1)}/creepStrain`, sig12(nortonCreepStrain(1e-10, 5, m, 50, 10)));
  });

  it('evaluates Garofalo', () => {
    expectCase(PACK, 'VC-MATL-11/garofalo/rate', sig12(garofaloRate(1.0e6, 0.01, 4, 300e3, 100, 900)));
  });

  const creepDoc = (creep: Record<string, unknown>): CadDocument => {
    let doc = withMaterial(createEmptyDocument(), 'hot');
    doc = addModel(doc, 'hot', 'elastic', { kind: 'elastic_isotropic', E: GPa(200), nu: ONE(0.3) });
    doc = addModel(doc, 'hot', 'creep', creep);
    return defineSet(doc, 'hot', { id: 's', elastic: 'elastic', creep: 'creep' }, true);
  };

  it.each([0, -0.5])('the driver reproduces Norton creep strain at constant stress (m = %s)', (m) => {
    const doc = creepDoc({ kind: 'creep_norton', A: 1e-10, n: 5, m, stressUnit: 'MPa', timeUnit: 'h', hardening: 'time' });
    const data = pointResponse(doc, {
      material: 'hot',
      kinematics: 'small',
      preset: 'uniaxial_stress',
      steps: [
        { increments: 1, duration: { value: 1e-6, unit: 's' }, control: { xx: { stress: MPa(50) } } },
        { increments: 10, duration: { value: 10, unit: 'h' }, control: { xx: { stress: MPa(50) } } },
      ],
    });
    const last = data.rows[1] as unknown as { eqCreepStrain: number; strain: number[]; stress: number[] };
    expect(last.eqCreepStrain).toBeCloseTo(nortonCreepStrain(1e-10, 5, m, 50, 10), 6);
    expect(last.strain[0]).toBeCloseTo(50 / 200000 + last.eqCreepStrain, 7);
    expect(last.stress[0]).toBeCloseTo(50, 6);
  });

  it('relaxes the stress under constant strain (Norton) and integrates Garofalo at temperature', () => {
    const norton = creepDoc({ kind: 'creep_norton', A: 1e-10, n: 5, m: 0, stressUnit: 'MPa', timeUnit: 'h', hardening: 'time' });
    const held = pointResponse(norton, {
      material: 'hot',
      kinematics: 'small',
      preset: 'uniaxial_stress',
      steps: [
        { increments: 1, duration: { value: 1e-6, unit: 's' }, control: { xx: { strain: 0.0005 } } },
        { increments: 200, duration: { value: 100, unit: 'h' }, control: { xx: { strain: 0.0005 } } },
      ],
    });
    expect(held.rows[1]?.stress[0]).toBeLessThan(held.rows[0]?.stress[0] ?? 0);
    const garofalo = creepDoc({
      kind: 'creep_garofalo',
      A: { value: 1e6, unit: '1/s' },
      alpha: { value: 0.01, unit: '1/MPa' },
      n: 4,
      activationEnergy: { value: 300000, unit: 'J/mol' },
    });
    const gStep = (temperature?: Record<string, unknown>): Record<string, unknown>[] => [
      { increments: 1, duration: { value: 1e-6, unit: 's' }, control: { xx: { stress: MPa(100) } }, ...temperature },
      { increments: 4, duration: { value: 1000, unit: 's' }, control: { xx: { stress: MPa(100) } }, ...temperature },
    ];
    const hot = pointResponse(garofalo, {
      material: 'hot',
      kinematics: 'small',
      preset: 'uniaxial_stress',
      steps: gStep({ temperature: { value: 900, unit: 'K' } }),
    });
    expect((hot.rows[1] as unknown as { eqCreepStrain: number }).eqCreepStrain).toBeCloseTo(
      garofaloRate(1.0e6, 0.01, 4, 300e3, 100, 900) * 1000,
      12,
    );
    expect(codeOf(garofalo, 'material_point_response', { material: 'hot', kinematics: 'small', steps: gStep() })).toBe(
      'PROP_VARIABLE_MISSING',
    );
  });

  it('refuses invalid creep parameters and unsupported hardening in the driver', () => {
    const doc = withMaterial(createEmptyDocument(), 'hot');
    const add = (model: Record<string, unknown>): string =>
      codeOf(doc, 'add_material_model', { material: 'hot', id: 'c', model, basis: 'typical', source: { citation: 'x' } });
    const norton = { kind: 'creep_norton', A: 1e-10, n: 5, m: 0, stressUnit: 'MPa', timeUnit: 'h', hardening: 'time' };
    expect(add({ ...norton, A: 0 })).toBe('MATL_CREEP_PARAMS_INVALID');
    expect(add({ ...norton, n: -1 })).toBe('MATL_CREEP_PARAMS_INVALID');
    expect(add({ ...norton, m: -1 })).toBe('MATL_CREEP_PARAMS_INVALID');
    expect(add({ ...norton, stressUnit: 'K' })).toBe('MATL_LAW_PARAMS_INVALID');
    expect(add(norton)).toBe('accepted');
    const garofalo = {
      kind: 'creep_garofalo',
      A: { value: 1, unit: '1/s' },
      alpha: { value: 0.01, unit: '1/MPa' },
      n: 4,
      activationEnergy: { value: 3e5, unit: 'J/mol' },
    };
    expect(add({ ...garofalo, n: 0 })).toBe('MATL_CREEP_PARAMS_INVALID');
    expect(add({ ...garofalo, A: { value: 0, unit: '1/s' } })).toBe('MATL_CREEP_PARAMS_INVALID');
    expect(add({ ...garofalo, alpha: { value: 0.01, unit: 'MPa' } })).toBe('MATL_LAW_PARAMS_INVALID');
    expect(add(garofalo)).toBe('accepted');
    const strain = creepDoc({ ...norton, hardening: 'strain' });
    expect(
      codeOf(strain, 'material_point_response', {
        material: 'hot',
        kinematics: 'small',
        steps: [{ increments: 1, control: { xx: { strain: 0.001 } } }],
      }),
    ).toBe('MATL_PATH_INVALID');
  });
});

describe('Johnson-Cook flow stress (VC-MATL-12)', () => {
  it('evaluates (A + B εp^n)(1 + C ln(ε̇/ε̇0))(1 − T*^m)', () => {
    const hardening = { A: 500, B: 300, n: 0.3, m: 1, meltTemperature: 1800, transitionTemperature: 293 };
    expectCase(
      PACK,
      'VC-MATL-12/johnsonCook/flowStress',
      sig12(johnsonCookFlowStress(hardening, { C: 0.015, referenceRate: 1 }, 0.1, 100, 600)),
    );
    expect(johnsonCookFlowStress(hardening, { C: 0.015, referenceRate: 1 }, 0.1, 0.5, 600)).toBeCloseTo(
      johnsonCookFlowStress(hardening, { C: 0.015, referenceRate: 1 }, 0.1, 1, 600),
      12,
    );
    expect(johnsonCookFlowStress(hardening, { C: 0, referenceRate: 1 }, 0.1, 1, 2000)).toBe(0);
  });
});
