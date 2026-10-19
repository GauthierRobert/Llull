/** M7: Hill-1948 anisotropic plasticity — coefficient conversions, return mapping against closed forms and the J2 reference, checks, cards. */
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import {
  coefficientsFromRValues,
  coefficientsFromStressRatios,
  hillEquivalent,
  hillFlowDirection,
  hillIsConvex,
  hillMatrix,
} from '@core/model/materialLaws/hill';
import {
  GPa,
  MPa,
  NL1_ELASTIC,
  NL1_PERFECT,
  ONE,
  T293,
  addModel,
  codeOf,
  defineSet,
  nl1Steps,
  pointResponse,
  withMaterial,
} from './materialFixtures';

const E = 200000;
const NU = 0.3;
const SIGMA0 = 250;
const ELASTIC = { kind: 'elastic_isotropic', E: GPa(200), nu: ONE(NU) };
const PERFECT = { kind: 'perfect', yieldStress: MPa(SIGMA0) };

const hillModel = (
  anisotropy: Record<string, unknown>,
  form = 'r_values',
  isotropic: Record<string, unknown> = PERFECT,
): Record<string, unknown> => ({ kind: 'hill48_plasticity', isotropic, form, anisotropy });

function sheet(anisotropy: Record<string, unknown>, form = 'r_values', isotropic: Record<string, unknown> = PERFECT): CadDocument {
  let doc = withMaterial(createEmptyDocument(), 'sheet');
  doc = addModel(doc, 'sheet', 'elastic', ELASTIC);
  doc = addModel(doc, 'sheet', 'hill', hillModel(anisotropy, form, isotropic));
  return defineSet(doc, 'sheet', { id: 's', elastic: 'elastic', plastic: 'hill' }, true);
}

const R = { r0: 2, r45: 1.2, r90: 1.5 };
const run = (doc: CadDocument, steps: unknown[], extra: Record<string, unknown> = {}): ReturnType<typeof pointResponse> =>
  pointResponse(doc, { material: 'sheet', kinematics: 'small', steps, ...extra });

describe('coefficients', () => {
  it('von Mises is the isotropic special case for stress ratios and r-values', () => {
    const ratios = coefficientsFromStressRatios({ R11: 1, R22: 1, R33: 1, R12: 1, R13: 1, R23: 1 });
    expect(ratios).toEqual({ F: 0.5, G: 0.5, H: 0.5, L: 1.5, M: 1.5, N: 1.5 });
    const rValues = coefficientsFromRValues(1, 1, 1);
    expect(rValues).toEqual({ F: 0.5, G: 0.5, H: 0.5, L: 1.5, M: 1.5, N: 1.5 });
    const p = hillMatrix(ratios ?? { F: 0, G: 0, H: 0, L: 0, M: 0, N: 0 });
    expect(hillEquivalent(p, [100, -40, 20, 30, 0, 10])).toBeCloseTo(
      Math.sqrt(0.5 * (140 ** 2 + 60 ** 2 + 80 ** 2) + 3 * (30 ** 2 + 10 ** 2)),
      10,
    );
  });

  it('the yield-stress ratios are reproduced by the yield function', () => {
    const c = coefficientsFromStressRatios({ R11: 1, R22: 1.1, R33: 0.9, R12: 0.8, R13: 1.2, R23: 1.05 });
    const p = hillMatrix(c ?? { F: 0, G: 0, H: 0, L: 0, M: 0, N: 0 });
    expect(hillEquivalent(p, [1, 0, 0, 0, 0, 0])).toBeCloseTo(1, 12);
    expect(hillEquivalent(p, [0, 1.1, 0, 0, 0, 0])).toBeCloseTo(1, 12);
    expect(hillEquivalent(p, [0, 0, 0.9, 0, 0, 0])).toBeCloseTo(1, 12);
    expect(hillEquivalent(p, [0, 0, 0, 0.8 / Math.sqrt(3), 0, 0])).toBeCloseTo(1, 12);
    expect(hillEquivalent(p, [0, 0, 0, 0, 1.2 / Math.sqrt(3), 0])).toBeCloseTo(1, 12);
    expect(hillEquivalent(p, [0, 0, 0, 0, 0, 1.05 / Math.sqrt(3)])).toBeCloseTo(1, 12);
  });

  it('the Lankford coefficients reproduce r0, r45, r90 from the flow direction and σ90 / σ45 from the yield function', () => {
    const c = coefficientsFromRValues(R.r0, R.r45, R.r90);
    if (c === null) throw new Error('null');
    const p = hillMatrix(c);
    const flow = (stress: number[]): number[] => hillFlowDirection(p, stress);
    const n0 = flow([1, 0, 0, 0, 0, 0]);
    expect((n0[1] ?? 0) / (n0[2] ?? 1)).toBeCloseTo(R.r0, 12);
    const n90 = flow([0, 1, 0, 0, 0, 0]);
    expect((n90[0] ?? 0) / (n90[2] ?? 1)).toBeCloseTo(R.r90, 12);
    const n45 = flow([0.5, 0.5, 0, 0.5, 0, 0]);
    const length = (n45[0] ?? 0) / 2 + (n45[1] ?? 0) / 2 + (n45[3] ?? 0) / 2;
    const width = (n45[0] ?? 0) / 2 + (n45[1] ?? 0) / 2 - (n45[3] ?? 0) / 2;
    expect(width / (n45[2] ?? 1)).toBeCloseTo(R.r45, 12);
    expect(length).toBeGreaterThan(0);
    const ratio90 = Math.sqrt((R.r90 * (1 + R.r0)) / (R.r0 * (1 + R.r90)));
    expect(1 / hillEquivalent(p, [0, 1, 0, 0, 0, 0])).toBeCloseTo(ratio90, 12);
    expect(1 / hillEquivalent(p, [0.5, 0.5, 0, 0.5, 0, 0])).toBeCloseTo(
      Math.sqrt((2 * R.r90 * (1 + R.r0)) / ((R.r0 + R.r90) * (1 + R.r45))),
      12,
    );
  });

  it('convexity: positive definite deviatoric form and positive shear coefficients', () => {
    expect(hillIsConvex({ F: 0.5, G: 0.5, H: 0.5, L: 1.5, M: 1.5, N: 1.5 })).toBe(true);
    expect(hillIsConvex({ F: -2, G: 1, H: 1, L: 1.5, M: 1.5, N: 1.5 })).toBe(false);
    expect(hillIsConvex({ F: 0.5, G: 0.5, H: 0.5, L: 0, M: 1.5, N: 1.5 })).toBe(false);
    expect(coefficientsFromRValues(0, 1, 1)).toBeNull();
    expect(coefficientsFromStressRatios({ R11: 1, R22: -1, R33: 1, R12: 1, R13: 1, R23: 1 })).toBeNull();
  });
});

describe('return mapping', () => {
  it('uniaxial tension in the rolling direction: closed-form linear hardening, r0 from the plastic flow, no extra stress', () => {
    const H = 5000;
    const doc = sheet(R, 'r_values', { kind: 'linear', yieldStress: MPa(SIGMA0), modulus: MPa(H), modulusKind: 'plastic' });
    const strain = 0.01;
    const row = run(doc, [{ increments: 20, control: { xx: { strain } } }], { preset: 'uniaxial_stress' }).rows[0];
    const sigma = (SIGMA0 + H * strain) / (1 + H / E);
    expect(row?.stress[0]).toBeCloseTo(sigma, 7);
    expect(row?.vonMises).toBeCloseTo(sigma, 7);
    expect(Math.abs(row?.stress[1] ?? 1)).toBeLessThan(1e-7);
    const plasticXX = strain - sigma / E;
    expect(row?.eqPlasticStrain).toBeCloseTo(plasticXX, 9);
    const elastic = (stress: number, others: number): number => (stress - NU * others) / E;
    const plastic22 = (row?.strain[1] ?? 0) - elastic(0, sigma);
    const plastic33 = (row?.strain[2] ?? 0) - elastic(0, sigma);
    expect(plastic22 / plastic33).toBeCloseTo(R.r0, 7);
    expect(plastic22 + plastic33).toBeCloseTo(-plasticXX, 9);
  });

  it('uniaxial tension in the transverse direction yields at σ0 / √(F + H) and flows with r90', () => {
    const doc = sheet(R);
    const row = run(doc, [{ increments: 10, control: { yy: { strain: 0.01 } } }], { preset: 'uniaxial_stress' }).rows[0];
    const c = coefficientsFromRValues(R.r0, R.r45, R.r90);
    const expected = SIGMA0 / Math.sqrt((c?.F ?? 0) + (c?.H ?? 0));
    expect(row?.stress[1]).toBeCloseTo(expected, 7);
    expect(expected / SIGMA0).toBeCloseTo(Math.sqrt((R.r90 * (1 + R.r0)) / (R.r0 * (1 + R.r90))), 12);
    const plastic11 = (row?.strain[0] ?? 0) + (NU * expected) / E;
    const plastic33 = (row?.strain[2] ?? 0) + (NU * expected) / E;
    expect(plastic11 / plastic33).toBeCloseTo(R.r90, 7);
  });

  it('with isotropic ratios it reproduces the J2 return mapping on the NAFEMS NL1 path (point 7, N = 10)', () => {
    let doc = withMaterial(createEmptyDocument(), 'nl1');
    doc = addModel(doc, 'nl1', 'elastic', NL1_ELASTIC, { validity: T293 });
    doc = addModel(doc, 'nl1', 'j2', NL1_PERFECT);
    doc = addModel(doc, 'nl1', 'hill', {
      kind: 'hill48_plasticity',
      isotropic: { kind: 'perfect', yieldStress: MPa(5) },
      form: 'stress_ratios',
      anisotropy: { R11: 1, R22: 1, R33: 1, R12: 1, R13: 1, R23: 1 },
    });
    doc = defineSet(doc, 'nl1', { id: 'j2', elastic: 'elastic', plastic: 'j2' }, true);
    doc = defineSet(doc, 'nl1', { id: 'hill', elastic: 'elastic', plastic: 'hill' });
    const path = { kinematics: 'small', preset: 'plane_strain', steps: nl1Steps(10), output: 'increments' };
    const j2 = pointResponse(doc, { material: 'nl1', set: 'j2', ...path }).rows;
    const hill = pointResponse(doc, { material: 'nl1', set: 'hill', ...path }).rows;
    expect(hill).toHaveLength(j2.length);
    j2.forEach((row, i) => {
      row.stress.forEach((value, c) => expect(hill[i]?.stress[c]).toBeCloseTo(value, 8));
      expect(hill[i]?.eqPlasticStrain).toBeCloseTo(row.eqPlasticStrain, 12);
    });
    expect(hill[hill.length - 1]?.eqPlasticStrain).toBeGreaterThan(0);
  });

  it('a biaxial stress path stays on the yield surface of the hardening curve and the flow is normal to it', () => {
    const doc = sheet(R, 'r_values', { kind: 'linear', yieldStress: MPa(SIGMA0), modulus: MPa(3000), modulusKind: 'plastic' });
    const c = coefficientsFromRValues(R.r0, R.r45, R.r90);
    if (c === null) throw new Error('null');
    const p = hillMatrix(c);
    const rows = run(doc, [{ increments: 40, control: { xx: { strain: 0.01 }, yy: { strain: 0.004 }, xy: { strain: 0.002 } } }], {
      preset: 'plane_strain',
      output: 'increments',
    }).rows;
    const last = rows[rows.length - 1];
    expect(hillEquivalent(p, last?.stress ?? [])).toBeCloseTo(SIGMA0 + 3000 * (last?.eqPlasticStrain ?? 0), 6);
    expect(last?.eqPlasticStrain).toBeGreaterThan(0.001);
    expect(last?.energyDensity).toBeGreaterThan(0);
  });

  it('works with an orthotropic elastic model in the material axes', () => {
    let doc = withMaterial(createEmptyDocument(), 'ortho');
    doc = addModel(doc, 'ortho', 'elastic', {
      kind: 'elastic_orthotropic',
      E1: GPa(200),
      E2: GPa(180),
      E3: GPa(190),
      nu12: ONE(0.3),
      nu13: ONE(0.3),
      nu23: ONE(0.3),
      G12: GPa(75),
      G13: GPa(75),
      G23: GPa(75),
    });
    doc = addModel(doc, 'ortho', 'hill', hillModel(R));
    doc = defineSet(doc, 'ortho', { id: 's', elastic: 'elastic', plastic: 'hill' }, true);
    const row = pointResponse(doc, {
      material: 'ortho',
      kinematics: 'small',
      preset: 'uniaxial_stress',
      steps: [{ increments: 10, control: { xx: { strain: 0.01 } } }],
    }).rows[0];
    expect(row?.stress[0]).toBeCloseTo(SIGMA0, 6);
    expect(row?.eqPlasticStrain).toBeGreaterThan(0.005);
  });
});

describe('definition, checks and exports', () => {
  const base = withMaterial(createEmptyDocument(), 'sheet');
  const add = (model: Record<string, unknown>, doc: CadDocument = base): string =>
    codeOf(doc, 'add_material_model', { material: 'sheet', id: 'h', model, basis: 'typical', source: { citation: 'synthetic' } });

  it('stores the six coefficients with the conversion recorded', () => {
    const stored = addModel(base, 'sheet', 'h', hillModel(R)).materials['sheet']?.materialModels?.[0];
    const law = stored?.model;
    if (law?.kind !== 'hill48_plasticity') throw new Error('not hill');
    expect(law.G).toBeCloseTo(1 / 3, 12);
    expect(law.H).toBeCloseTo(2 / 3, 12);
    expect(stored?.conversion?.from).toBe('hill48 r_values');
    expect(Object.keys(law).sort()).toEqual(['F', 'G', 'H', 'L', 'M', 'N', 'isotropic', 'kind']);
  });

  it('refuses a missing form, bad values, a non-convex surface and bad hardening', () => {
    expect(add({ kind: 'hill48_plasticity', isotropic: PERFECT, anisotropy: R })).toBe('MATL_LAW_PARAMS_INVALID');
    expect(add(hillModel({ r0: 2, r45: 1.2 }))).toBe('MATL_LAW_PARAMS_INVALID');
    expect(add(hillModel({ r0: -2, r45: 1.2, r90: 1 }))).toBe('MATL_LAW_PARAMS_INVALID');
    expect(add(hillModel({ F: -2, G: 1, H: 1, L: 1.5, M: 1.5, N: 1.5 }, 'coefficients'))).toBe('MATL_HILL_NOT_CONVEX');
    expect(add(hillModel({ F: 0.5, G: 0.5, H: Number.NaN, L: 1.5, M: 1.5, N: 1.5 }, 'coefficients'))).toBe('MATL_LAW_PARAMS_INVALID');
    expect(add(hillModel(R, 'r_values', { kind: 'linear', yieldStress: MPa(250), modulus: MPa(1) }))).toBe(
      'MATL_HARDENING_MODULUS_KIND_MISSING',
    );
    expect(add(hillModel(R, 'r_values', { kind: 'perfect', yieldStress: MPa(-1) }))).toBe('MATL_LAW_PARAMS_INVALID');
  });

  it('combination rules: isotropic or orthotropic elasticity only, never with hyperelastic or a rate law', () => {
    let doc = addModel(base, 'sheet', 'hill', hillModel(R));
    doc = addModel(doc, 'sheet', 'e', ELASTIC);
    doc = addModel(doc, 'sheet', 'hyper', { kind: 'hyper_neo_hooke', C10: MPa(0.2), D1: { value: 0, unit: '1/MPa' } });
    doc = addModel(doc, 'sheet', 'rate', { kind: 'rate_cowper_symonds', D: { value: 40, unit: '1/s' }, q: 5 });
    doc = addModel(doc, 'sheet', 'aniso', {
      kind: 'elastic_anisotropic',
      stiffness: Array.from({ length: 21 }, (_, i) => (i === 0 || i === 6 || i === 11 || i === 15 || i === 18 || i === 20 ? 1e5 : 0)),
      unit: 'MPa',
    });
    const define = (set: Record<string, unknown>): string => codeOf(doc, 'define_constitutive_set', { material: 'sheet', set });
    expect(define({ id: 'a', elastic: 'e', plastic: 'hill' })).toBe('accepted');
    expect(define({ id: 'b', hyperelastic: 'hyper', plastic: 'hill' })).toBe('MATL_COMBINATION_INVALID');
    expect(define({ id: 'c', elastic: 'aniso', plastic: 'hill' })).toBe('MATL_COMBINATION_INVALID');
    expect(define({ id: 'd', elastic: 'e', plastic: 'hill', rate: 'rate' })).toBe('MATL_COMBINATION_INVALID');
  });

  it('check_material_models passes a convex set and export refuses CalculiX and Nastran with MATL_EXPORT_UNSUPPORTED', () => {
    let doc = withMaterial(createEmptyDocument(), 'sheet');
    doc = addModel(doc, 'sheet', 'elastic', ELASTIC, { validity: T293 });
    doc = addModel(doc, 'sheet', 'hill', hillModel(R), { validity: T293 });
    doc = defineSet(doc, 'sheet', { id: 's', elastic: 'elastic', plastic: 'hill' }, true);
    const check = execute(doc, 'check_material_models', {});
    expect(check.error).toBeUndefined();
    expect(JSON.stringify(check.data)).not.toContain('MATL_HILL');
    for (const target of ['calculix', 'nastran']) {
      const result = execute(doc, 'export_material_cards', { material: 'sheet', target });
      expect(result.error?.code, target).toBe('MATL_EXPORT_UNSUPPORTED');
    }
  });

  it('refuses a tangent-modulus hardening with orthotropic elasticity (E is not defined) at drive time', () => {
    let doc = withMaterial(createEmptyDocument(), 'ortho');
    doc = addModel(doc, 'ortho', 'elastic', {
      kind: 'elastic_orthotropic',
      E1: GPa(200),
      E2: GPa(180),
      E3: GPa(190),
      nu12: ONE(0.3),
      nu13: ONE(0.3),
      nu23: ONE(0.3),
      G12: GPa(75),
      G13: GPa(75),
      G23: GPa(75),
    });
    doc = addModel(
      doc,
      'ortho',
      'hill',
      hillModel(R, 'r_values', { kind: 'linear', yieldStress: MPa(250), modulus: MPa(1000), modulusKind: 'tangent' }),
    );
    doc = defineSet(doc, 'ortho', { id: 's', elastic: 'elastic', plastic: 'hill' }, true);
    expect(
      codeOf(doc, 'material_point_response', { material: 'ortho', kinematics: 'small', steps: [{ control: { xx: { strain: 0.01 } } }] }),
    ).toBe('MATL_LAW_PARAMS_INVALID');
  });
});
