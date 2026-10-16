/** VC-MATL-04: Ramberg-Osgood conversion and deformation-theory driver; MATL_DEFORMATION_THEORY_PATH. */
import { describe, expect, it } from 'vitest';
import { engineeringToCalculix, roSolve, roStrain, roUniaxialStrain } from '@core/model/materialLaws/rambergOsgood';
import { createEmptyDocument } from '@core/model/types';
import { expectCase } from '../benchmarkCases';
import { GPa, MPa, ONE, PACK, addModel, codeOf, defineSet, pointResponse, sig12, withMaterial } from './materialFixtures';

const ENGINEERING = { kind: 'ramberg_osgood', form: 'engineering', E: GPa(72), nu: ONE(0.33), sigma02: MPa(400), n: 15 };
const VALIDITY = [{ variable: 'T', unit: 'K', data: [293, 293] }];

const setup = (): ReturnType<typeof createEmptyDocument> => {
  let doc = withMaterial(createEmptyDocument(), 'al');
  doc = addModel(doc, 'al', 'ro', ENGINEERING, { validity: VALIDITY });
  return defineSet(doc, 'al', { id: 'ro', plastic: 'ro' }, true);
};

describe('Ramberg-Osgood (VC-MATL-04)', () => {
  it('converts the engineering form to the CalculiX form and records the conversion', () => {
    const stored = setup().materials['al']?.materialModels?.[0];
    const law = stored?.model;
    expect(law?.kind).toBe('ramberg_osgood');
    if (law?.kind !== 'ramberg_osgood') return;
    expectCase(PACK, 'VC-MATL-04/RO/alpha', sig12(law.alpha));
    expect(law.sigma0).toEqual(MPa(400));
    expect(stored?.conversion?.from).toBe('ramberg_osgood engineering form');
    expect(engineeringToCalculix(72000, 400)).toEqual({ sigma0: 400, alpha: 0.36 });
  });

  it('drives the point: strain at σ0.2 and stress at ε = 0.01 (uniaxial stress)', () => {
    const doc = setup();
    const atYield = pointResponse(doc, {
      material: 'al',
      kinematics: 'small',
      preset: 'uniaxial_stress',
      steps: [{ increments: 1, control: { xx: { stress: MPa(400) } } }],
    });
    expectCase(PACK, 'VC-MATL-04/RO/strainAt_s02', sig12(atYield.rows[0]?.strain[0] ?? Number.NaN));
    const atStrain = pointResponse(doc, {
      material: 'al',
      kinematics: 'small',
      preset: 'uniaxial_stress',
      steps: [{ increments: 4, control: { xx: { strain: 0.01 } } }],
    });
    expectCase(PACK, 'VC-MATL-04/RO/stressAt_eps0.01', atStrain.rows[0]?.stress[0] ?? Number.NaN);
    expect(atStrain.rows[0]?.stress[1]).toBeCloseTo(0, 9);
    expect(atStrain.rows[0]?.eqPlasticStrain).toBeGreaterThan(0.002);
    expect(atStrain.warnings).toEqual([]);
  });

  it('matches the 1D formula and the multiaxial deformation theory', () => {
    const material = { E: 72000, nu: 0.33, sigma0: 400, n: 15, alpha: 0.36 };
    expect(roUniaxialStrain(material, 400)).toBeCloseTo(0.00755555555556, 12);
    expect(roStrain(material, [400, 0, 0, 0, 0, 0])[0]).toBeCloseTo(roUniaxialStrain(material, 400), 12);
    const mixed = roSolve(material, [
      { kind: 'strain', value: 0.004 },
      { kind: 'stress', value: 0 },
      { kind: 'strain', value: 0 },
      { kind: 'stress', value: 0 },
      { kind: 'stress', value: 0 },
      { kind: 'stress', value: 0 },
    ]);
    expect(mixed?.strain[0]).toBeCloseTo(0.004, 12);
    expect(mixed?.stress[1]).toBeCloseTo(0, 9);
    expect(mixed?.strain[2]).toBeCloseTo(0, 12);
    expect(
      roSolve(
        material,
        Array.from({ length: 6 }, () => ({ kind: 'strain' as const, value: Number.NaN })),
      ),
    ).toBeNull();
  });

  it('warns on non-proportional loading and unloading (MATL_DEFORMATION_THEORY_PATH)', () => {
    const doc = setup();
    const unloading = pointResponse(doc, {
      material: 'al',
      kinematics: 'small',
      preset: 'uniaxial_stress',
      steps: [
        { increments: 5, control: { xx: { strain: 0.005 } } },
        { increments: 5, control: { xx: { strain: 0.002 } } },
      ],
    });
    expect(unloading.warnings.map((w) => w.code)).toEqual(['MATL_DEFORMATION_THEORY_PATH']);
    expect(unloading.warnings[0]?.step).toBe(2);
    const nonProportional = pointResponse(doc, {
      material: 'al',
      kinematics: 'small',
      steps: [
        { increments: 5, control: { xx: { strain: 0.005 } } },
        { increments: 5, control: { xx: { strain: 0.005 }, xy: { strain: 0.004 } } },
      ],
    });
    expect(nonProportional.warnings.map((w) => w.code)).toEqual(['MATL_DEFORMATION_THEORY_PATH']);
  });

  it('refuses a missing form, a missing sigma02 and nonsense parameters', () => {
    const doc = withMaterial(createEmptyDocument(), 'al');
    const add = (model: Record<string, unknown>): string =>
      codeOf(doc, 'add_material_model', { material: 'al', id: 'ro', model, basis: 'typical', source: { citation: 'x' } });
    expect(add({ ...ENGINEERING, form: undefined })).toBe('MATL_LAW_PARAMS_INVALID');
    expect(add({ ...ENGINEERING, sigma02: undefined })).toBe('MATL_LAW_PARAMS_INVALID');
    expect(add({ ...ENGINEERING, n: 1 })).toBe('MATL_LAW_PARAMS_INVALID');
    expect(add({ ...ENGINEERING, nu: ONE(0.5) })).toBe('MATL_POISSON_BOUND');
    expect(add({ kind: 'ramberg_osgood', form: 'calculix', E: GPa(72), nu: ONE(0.33), sigma0: MPa(400), n: 15, alpha: 0.36 })).toBe(
      'accepted',
    );
    expect(add({ kind: 'ramberg_osgood', form: 'calculix', E: GPa(72), nu: ONE(0.33), sigma0: MPa(400), n: 15, alpha: -1 })).toBe(
      'MATL_LAW_PARAMS_INVALID',
    );
  });
});
