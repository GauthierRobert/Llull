/** fit_material_model for Ramberg-Osgood and Prony series (fixed relaxation times). */
import { describe, expect, it } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import { pronyRatio } from '@core/model/materialLaws/viscoelastic';
import { SOURCE, addModel, codeOf, run, withMaterial } from './materialFixtures';

const doc = createEmptyDocument();
const E = 72000;
const strainAt = (sigma: number): number => sigma / E + 0.002 * (sigma / 400) ** 15;
const roRows = [300, 340, 370, 390, 400, 410, 420, 440].map((sigma) => [strainAt(sigma), sigma]);
const roTest = { mode: 'uniaxial_plastic', rows: roRows, xMeasure: 'total_strain', yMeasure: 'true_stress', units: { y: 'MPa' } };
const FIXED = { E: { value: 72, unit: 'GPa' }, nu: { value: 0.33, unit: '1' } };

interface Fit {
  model: Record<string, unknown>;
  fit: { residual: { rms: number; unit: string }; fittedRange: { variable: string }[] };
  validity: unknown[];
  residualsPerTest: { mode: string; rms: number }[];
  warnings: unknown[];
}

describe('Ramberg-Osgood fit', () => {
  it('recovers n and σ0.2 from exact data and returns a model add_material_model accepts', () => {
    const data = run(doc, 'fit_material_model', { kind: 'ramberg_osgood', tests: [roTest], fixed: FIXED }).data as Fit;
    const sigma02 = data.model['sigma02'] as { value: number };
    expect(data.model['n']).toBeCloseTo(15, 9);
    expect(sigma02.value).toBeCloseTo(400, 7);
    expect(data.fit.residual.rms).toBeLessThan(1e-12);
    expect(data.fit.fittedRange[0]?.variable).toBe('equivalentPlasticStrain');
    const added = run(withMaterial(doc, 'al'), 'add_material_model', {
      material: 'al',
      id: 'ro',
      model: data.model,
      validity: data.validity,
      basis: 'typical',
      source: SOURCE,
    });
    const stored = added.document.materials['al']?.materialModels?.[0]?.model;
    expect(stored?.kind === 'ramberg_osgood' ? stored.alpha : 0).toBeCloseTo(0.36, 6);
  });

  it('refuses data it cannot use', () => {
    const fit = (patch: Record<string, unknown>): string =>
      codeOf(doc, 'fit_material_model', { kind: 'ramberg_osgood', tests: [roTest], fixed: FIXED, ...patch });
    expect(fit({})).toBe('accepted');
    expect(fit({ fixed: undefined })).toBe('MATL_LAW_PARAMS_INVALID');
    expect(fit({ fixed: { E: FIXED.E } })).toBe('MATL_LAW_PARAMS_INVALID');
    expect(fit({ tests: [{ ...roTest, mode: 'uniaxial' }] })).toBe('MATL_LAW_PARAMS_INVALID');
    expect(fit({ tests: [roTest, roTest] })).toBe('MATL_LAW_PARAMS_INVALID');
    expect(fit({ tests: [{ ...roTest, rows: roRows.slice(0, 2) }] })).toBe('MATL_FIT_INSUFFICIENT_DATA');
    expect(
      fit({
        tests: [
          {
            ...roTest,
            rows: [
              [0.001, 100],
              [0.002, 200],
              [0.003, 300],
              [0.004, 400],
            ],
          },
        ],
      }),
    ).toBe('MATL_FIT_INSUFFICIENT_DATA');
    expect(fit({ tests: [{ ...roTest, units: {} }] })).toBe('MATL_LAW_PARAMS_INVALID');
    expect(fit({ tests: [{ ...roTest, units: { y: 'K' } }] })).toBe('MATL_LAW_PARAMS_INVALID');
    expect(fit({ tests: [{ ...roTest, rows: [[1, 2, 3]] }] })).toBe('MATL_LAW_PARAMS_INVALID');
    expect(fit({ fixed: { E: { value: 1, unit: 'K' }, nu: FIXED.nu } })).toBe('MATL_LAW_PARAMS_INVALID');
    const flat = [300, 310, 320, 330].map((sigma) => [0.5 + 0.0001 * sigma, sigma]);
    expect(fit({ tests: [{ ...roTest, rows: flat }] })).toBe('MATL_FIT_ILL_CONDITIONED');
    expect(
      fit({
        tests: [
          {
            ...roTest,
            rows: [
              [strainAt(400), 400],
              [strainAt(400), 400],
              [strainAt(400), 400],
            ],
          },
        ],
      }),
    ).toBe('MATL_FIT_ILL_CONDITIONED');
  });
});

describe('Prony fit with fixed relaxation times', () => {
  const g = [0.3, 0.2];
  const tau = [0.1, 10];
  const times = [0, 0.02, 0.05, 0.1, 0.3, 1, 3, 10, 30, 100];
  const G0 = 1000;
  const relaxation = {
    mode: 'relaxation',
    rows: times.map((t) => [t, G0 * pronyRatio(g, tau, t)]),
    xMeasure: 'time',
    yMeasure: 'shear_modulus',
    units: { x: 's', y: 'MPa' },
  };
  const fixed = { tau: tau.map((value) => ({ value, unit: 's' })) };

  it('recovers the weights from exact relaxation data', () => {
    const data = run(doc, 'fit_material_model', { kind: 'visco_prony', tests: [relaxation], fixed }).data as Fit;
    const shear = data.model['shear'] as { g: number; tau: { value: number } }[];
    expect(shear.map((term) => term.g)[0]).toBeCloseTo(0.3, 9);
    expect(shear.map((term) => term.g)[1]).toBeCloseTo(0.2, 9);
    expect(data.fit.residual.unit).toBe('1');
    const added = run(withMaterial(doc, 'poly'), 'add_material_model', {
      material: 'poly',
      id: 'v',
      model: data.model,
      validity: data.validity,
      basis: 'typical',
      source: SOURCE,
    });
    expect(added.document.materials['poly']?.materialModels?.[0]?.model.kind).toBe('visco_prony');
    const noZero = { ...relaxation, rows: relaxation.rows.slice(1) };
    expect(codeOf(doc, 'fit_material_model', { kind: 'visco_prony', tests: [noZero], fixed })).toBe('MATL_LAW_PARAMS_INVALID');
    expect(
      codeOf(doc, 'fit_material_model', { kind: 'visco_prony', tests: [noZero], fixed: { ...fixed, G0: { value: 1, unit: 'GPa' } } }),
    ).toBe('accepted');
  });

  it('refuses unusable relaxation data', () => {
    const fit = (patch: Record<string, unknown>): string =>
      codeOf(doc, 'fit_material_model', { kind: 'visco_prony', tests: [relaxation], fixed, ...patch });
    expect(fit({ fixed: { tau: [] } })).toBe('MATL_LAW_PARAMS_INVALID');
    expect(fit({ fixed: { tau: [{ value: 0, unit: 's' }] } })).toBe('MATL_LAW_PARAMS_INVALID');
    expect(fit({ fixed: { tau: [{ value: 1, unit: 'K' }] } })).toBe('MATL_LAW_PARAMS_INVALID');
    expect(fit({ tests: [{ ...relaxation, mode: 'creep' }] })).toBe('MATL_LAW_PARAMS_INVALID');
    expect(fit({ tests: [{ ...relaxation, units: { y: 'MPa' } }] })).toBe('MATL_LAW_PARAMS_INVALID');
    expect(fit({ tests: [{ ...relaxation, units: { x: 'K', y: 'MPa' } }] })).toBe('MATL_LAW_PARAMS_INVALID');
    expect(
      fit({
        tests: [
          {
            ...relaxation,
            rows: [
              [0, 1],
              [1, 0.9],
            ],
          },
        ],
        fixed: {
          tau: [
            { value: 1, unit: 's' },
            { value: 2, unit: 's' },
          ],
        },
      }),
    ).toBe('MATL_FIT_INSUFFICIENT_DATA');
    expect(
      fit({
        tests: [
          {
            ...relaxation,
            rows: [
              [0, 1000],
              [1, 1100],
              [2, 1200],
              [3, 1300],
            ],
          },
        ],
      }),
    ).toBe('MATL_PRONY_INVALID');
    expect(
      fit({
        tests: [
          {
            ...relaxation,
            rows: [
              [0, 1000],
              [1, 900],
              [1, 900],
              [1, 900],
            ],
          },
        ],
        fixed: {
          tau: [
            { value: 1, unit: 's' },
            { value: 1, unit: 's' },
          ],
        },
      }),
    ).toBe('MATL_FIT_ILL_CONDITIONED');
    expect(
      fit({
        tests: [
          {
            ...relaxation,
            rows: [
              [0, 0],
              [1, 0],
            ],
          },
        ],
      }),
    ).toBe('MATL_LAW_PARAMS_INVALID');
  });
});

describe('fit_material_model is pure', () => {
  it('leaves the document untouched', () => {
    const base = withMaterial(doc, 'al');
    const snapshot = structuredClone(base);
    const result = run(base, 'fit_material_model', { kind: 'ramberg_osgood', tests: [roTest], fixed: FIXED });
    expect(base).toEqual(snapshot);
    expect(result.document).toBe(base);
    expect(result.affected).toEqual([]);
    expect(
      addModel(base, 'al', 'x', { kind: 'elastic_isotropic', E: { value: 1, unit: 'GPa' }, nu: { value: 0.3, unit: '1' } }).materials['al'],
    ).toBeDefined();
  });
});
