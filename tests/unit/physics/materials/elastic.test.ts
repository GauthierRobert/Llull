/** VC-MATL-03: elastic conversions, positive definiteness and Poisson bounds (kernels and add_material_model). */
import { describe, expect, it } from 'vitest';
import {
  expandTransverselyIsotropic,
  orthotropicCompliance,
  orthotropicReport,
  stiffnessFromCompliance,
  stiffnessReport,
  stiffnessToEngineeringConstants,
  symmetricFromUpperTriangle,
} from '@core/model/materialLaws/elastic';
import { invertMatrix, pivotReport, solveLinear } from '@core/model/materialLaws/linalg';
import { createEmptyDocument } from '@core/model/types';
import { expectCase } from '../benchmarkCases';
import { GPa, MPa, ONE, PACK, addModel, codeOf, run, withMaterial } from './materialFixtures';

const SYNTH = { E1: 135000, E2: 10000, E3: 10000, nu12: 0.3, nu13: 0.3, nu23: 0.45, G12: 5000, G13: 5000, G23: 3448 };

describe('elastic kernels (VC-MATL-03)', () => {
  it('converts engineering constants to the CalculiX ORTHO D values', () => {
    const c = stiffnessFromCompliance(orthotropicCompliance(SYNTH));
    expect(c).not.toBeNull();
    const at = (i: number, j: number): number => c?.[i]?.[j] ?? Number.NaN;
    expectCase(PACK, 'VC-MATL-03/orthoSynthetic/calculixORTHO', [
      at(0, 0),
      at(0, 1),
      at(1, 1),
      at(0, 2),
      at(1, 2),
      at(2, 2),
      at(3, 3),
      at(4, 4),
      at(5, 5),
    ]);
  });

  it('tests positive definiteness and finds the Lempriere bound', () => {
    expectCase(PACK, 'VC-MATL-03/orthoSynthetic/positiveDefinite', orthotropicReport(SYNTH).positiveDefinite);
    const bad = orthotropicReport({ ...SYNTH, nu12: 3.8 });
    expectCase(PACK, 'VC-MATL-03/orthoInvalid/nu12=3.8', bad.positiveDefinite);
    expect(bad.failingPivot).toBe(1);
    expect(bad.poissonBounds?.[0]).toMatchObject({ pair: '12', satisfied: false });
    expect(bad.poissonBounds?.[0]?.limit).toBeCloseTo(Math.sqrt(13.5), 12);
  });

  it('converts the CalculiX manual ORTHO example back to engineering constants', () => {
    const upper = [500000, 157200, 157200, 0, 0, 0, 400000, 157200, 0, 0, 0, 300000, 0, 0, 0, 126200, 0, 0, 126200, 0, 126200];
    const c = symmetricFromUpperTriangle(upper);
    const constants = stiffnessToEngineeringConstants(c);
    expect(stiffnessReport(c).positiveDefinite).toBe(true);
    expectCase(PACK, 'VC-MATL-03/ccxManualORTHO/engineeringConstants', {
      E1: constants?.E1 ?? Number.NaN,
      E2: constants?.E2 ?? Number.NaN,
      E3: constants?.E3 ?? Number.NaN,
      nu12: constants?.nu12 ?? Number.NaN,
      nu13: constants?.nu13 ?? Number.NaN,
      nu23: constants?.nu23 ?? Number.NaN,
    });
  });

  it('expands transversely isotropic constants in both orientations', () => {
    const plane12 = expandTransverselyIsotropic('12', 10000, 135000, 0.3, 0.02, 5000);
    expect(plane12).toMatchObject({ E1: 10000, E2: 10000, E3: 135000, nu12: 0.3, nu13: 0.02, nu23: 0.02, G13: 5000, G23: 5000 });
    expect(plane12.G12).toBeCloseTo(10000 / 2.6, 10);
    const plane23 = expandTransverselyIsotropic('23', 10000, 135000, 0.3, 0.02, 5000);
    expect(plane23).toMatchObject({ E1: 135000, E2: 10000, E3: 10000, nu23: 0.3, G12: 5000, G13: 5000 });
    expect(plane23.nu12).toBeCloseTo((0.02 * 135000) / 10000, 12);
    expect(orthotropicReport(plane23).positiveDefinite).toBe(true);
  });

  it('solves and inverts small systems and refuses singular ones', () => {
    expect(
      solveLinear(
        [
          [2, 1],
          [1, 3],
        ],
        [3, 5],
      ),
    ).toEqual([0.8, 1.4]);
    expect(
      solveLinear(
        [
          [1, 2],
          [2, 4],
        ],
        [1, 2],
      ),
    ).toBeNull();
    expect(
      invertMatrix([
        [1, 2],
        [2, 4],
      ]),
    ).toBeNull();
    expect(
      pivotReport([
        [1, 2],
        [2, 1],
      ]).failingPivot,
    ).toBe(1);
  });
});

describe('elastic laws through add_material_model (VC-MATL-03, 15)', () => {
  const doc = withMaterial(createEmptyDocument(), 'cfrp');
  const ortho = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    kind: 'elastic_orthotropic',
    E1: MPa(135000),
    E2: MPa(10000),
    E3: MPa(10000),
    nu12: ONE(0.3),
    nu13: ONE(0.3),
    nu23: ONE(0.45),
    G12: MPa(5000),
    G13: MPa(5000),
    G23: MPa(3448),
    ...overrides,
  });
  const add = (model: Record<string, unknown>, id = 'm'): string =>
    codeOf(doc, 'add_material_model', { material: 'cfrp', id, model, basis: 'typical', source: { citation: 'x' } });

  it('accepts a positive definite orthotropic set and records its hash', () => {
    const next = addModel(doc, 'cfrp', 'ortho', ortho());
    const stored = next.materials['cfrp']?.materialModels?.[0];
    expect(stored?.parametersSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(stored?.model.kind).toBe('elastic_orthotropic');
  });

  it('refuses isotropic ν = 0.5 and ν = −1 with MATL_POISSON_BOUND (VC-MATL-03/isoBound)', () => {
    for (const nu of [0.5, -1]) {
      expectCase(PACK, `VC-MATL-03/isoBound/nu=${nu.toFixed(1)}`, add({ kind: 'elastic_isotropic', E: GPa(70), nu: ONE(nu) }));
    }
  });

  it('refuses ν12 = 3.8 with MATL_ELASTIC_NOT_POSITIVE_DEFINITE naming the bound', () => {
    const result = run(doc, 'check_material_models', {});
    expect(result.data).toBeDefined();
    const refused = codeOf(doc, 'add_material_model', {
      material: 'cfrp',
      id: 'm',
      model: ortho({ nu12: ONE(3.8) }),
      basis: 'typical',
      source: { citation: 'x' },
    });
    expect(refused).toBe('MATL_ELASTIC_NOT_POSITIVE_DEFINITE');
  });

  it('warns near incompressibility and refuses non-positive moduli, bad units and missing property models', () => {
    const near = run(doc, 'add_material_model', {
      material: 'cfrp',
      id: 'near',
      model: { kind: 'elastic_isotropic', E: GPa(1), nu: ONE(0.4999999) },
      basis: 'typical',
      source: { citation: 'x' },
    });
    expect((near.data as { warnings: { code: string }[] }).warnings.map((w) => w.code)).toEqual(['MATL_NEAR_INCOMPRESSIBLE']);
    expect(add({ kind: 'elastic_isotropic', E: MPa(-1), nu: ONE(0.3) })).toBe('MATL_LAW_PARAMS_INVALID');
    expect(add({ kind: 'elastic_isotropic', E: { value: 1, unit: 'K' }, nu: ONE(0.3) })).toBe('MATL_LAW_PARAMS_INVALID');
    expect(add({ kind: 'elastic_isotropic', E: { value: 1, unit: 'nonsense' }, nu: ONE(0.3) })).toBe('MATL_LAW_PARAMS_INVALID');
    expect(add({ kind: 'elastic_isotropic', E: { propertyModelId: 'E(T)' }, nu: ONE(0.3) })).toBe('MATL_LAW_PARAMS_INVALID');
    expect(add({ kind: 'elastic_isotropic', E: MPa(Number.NaN), nu: ONE(0.3) })).toBe('MATL_LAW_PARAMS_INVALID');
  });

  it('validates transversely isotropic and anisotropic laws', () => {
    const transverse = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
      kind: 'elastic_transversely_isotropic',
      isotropyPlane: '12',
      Ep: MPa(10000),
      Et: MPa(135000),
      nuP: ONE(0.3),
      nuPT: ONE(0.02),
      Gt: MPa(5000),
      ...overrides,
    });
    expect(add(transverse())).toBe('accepted');
    expect(add(transverse({ Gt: MPa(-1) }))).toBe('MATL_LAW_PARAMS_INVALID');
    expect(add(transverse({ nuPT: ONE(2) }))).toBe('MATL_ELASTIC_NOT_POSITIVE_DEFINITE');
    const upper = [500000, 157200, 157200, 0, 0, 0, 400000, 157200, 0, 0, 0, 300000, 0, 0, 0, 126200, 0, 0, 126200, 0, 126200];
    expect(add({ kind: 'elastic_anisotropic', stiffness: upper, unit: 'MPa' })).toBe('accepted');
    expect(add({ kind: 'elastic_anisotropic', stiffness: upper.slice(0, 20), unit: 'MPa' })).toBe('MATL_LAW_PARAMS_INVALID');
    expect(add({ kind: 'elastic_anisotropic', stiffness: upper.map((v, i) => (i === 0 ? -1 : v)), unit: 'MPa' })).toBe(
      'MATL_ELASTIC_NOT_POSITIVE_DEFINITE',
    );
    expect(add({ kind: 'elastic_anisotropic', stiffness: upper, unit: 'K' })).toBe('MATL_LAW_PARAMS_INVALID');
  });
});
