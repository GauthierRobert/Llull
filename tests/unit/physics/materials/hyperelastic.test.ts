/** VC-MATL-06, 07, 09: hyperelastic nominal stresses, the Ogden convention, the Drucker scan, the finite driver and law validation. */
import { describe, expect, it } from 'vitest';
import { druckerScan } from '@core/model/materialLaws/drucker';
import { nominalStress, type HyperMode, type ResolvedHyper } from '@core/model/materialLaws/hyperelastic';
import { resolveHyper, type HyperLaw } from '@core/model/materialLaws/hyperResolve';
import type { MaterialLaw } from '@core/model/materialModel';
import { createEmptyDocument } from '@core/model/types';
import { expectCase } from '../benchmarkCases';
import { MPa, PACK, SOURCE, addModel, codeOf, defineSet, pointResponse, run, sig12, withMaterial } from './materialFixtures';

const D0 = { value: 0, unit: '1/MPa' };
const LAWS: Readonly<Record<string, Record<string, unknown>>> = {
  neoHooke: { kind: 'hyper_neo_hooke', C10: MPa(0.2), D1: D0 },
  mooneyRivlin: { kind: 'hyper_mooney_rivlin', C10: MPa(0.16), C01: MPa(0.02), D1: D0 },
  yeoh: { kind: 'hyper_yeoh', C10: MPa(0.18), C20: MPa(-0.002), C30: MPa(0.0001), D: [0, 0, 0], compliance: '1/MPa' },
  arrudaBoyce: { kind: 'hyper_arruda_boyce', mu: MPa(0.27), lambdaM: 2.8, D: D0 },
  ogden1972set: {
    kind: 'hyper_ogden',
    convention: 'ogden1972',
    terms: [
      { mu: 0.63, alpha: 1.3 },
      { mu: 0.0012, alpha: 5 },
      { mu: -0.01, alpha: -2 },
    ],
    D: [0, 0, 0],
    stressUnit: 'MPa',
  },
};
const MODES: readonly (readonly [HyperMode, 'uniaxial' | 'equibiaxial' | 'planar'])[] = [
  ['UT', 'uniaxial'],
  ['ET', 'equibiaxial'],
  ['PS', 'planar'],
];

function storedLaw(name: string): MaterialLaw {
  const doc = addModel(withMaterial(createEmptyDocument(), 'rubber'), 'rubber', name, LAWS[name] ?? {});
  const law = doc.materials['rubber']?.materialModels?.[0]?.model;
  if (law === undefined) throw new Error('law not stored');
  return law;
}

const resolved = (name: string): ResolvedHyper => {
  const law = resolveHyper(storedLaw(name) as HyperLaw);
  if (law === null) throw new Error(`${name} does not resolve`);
  return law;
};

describe('hyperelastic stresses (VC-MATL-06)', () => {
  it.each(Object.keys(LAWS))('%s: nominal stress at stretch 2 in UT / ET / PS', (name) => {
    for (const [mode] of MODES) expectCase(PACK, `VC-MATL-06/${name}/${mode}/lambda=2`, sig12(nominalStress(resolved(name), mode, 2)));
  });

  it('the finite driver returns the same nominal stress, Hencky strain and Cauchy stress', () => {
    let doc = addModel(withMaterial(createEmptyDocument(), 'rubber'), 'rubber', 'nh', LAWS['neoHooke'] ?? {});
    doc = defineSet(doc, 'rubber', { id: 's', hyperelastic: 'nh' }, true);
    for (const [mode, preset] of [
      ['UT', 'uniaxial_stress'],
      ['ET', 'equibiaxial'],
      ['PS', 'pure_shear'],
    ] as const) {
      const data = pointResponse(doc, {
        material: 'rubber',
        kinematics: 'finite',
        preset,
        steps: [{ increments: 4, control: { xx: { strain: 1 } } }],
      });
      const row = data.rows[0] as unknown as {
        nominalStress: number;
        stretch: number[];
        strain: number[];
        stress: number[];
        energyDensity: number;
      };
      expectCase(PACK, `VC-MATL-06/neoHooke/${mode}/lambda=2`, sig12(row.nominalStress));
      expect(row.stretch[0]).toBe(2);
      expect(row.strain[0]).toBeCloseTo(Math.log(2), 12);
      expect(row.stress[0]).toBeCloseTo(2 * row.nominalStress, 12);
      expect(row.stress[2]).toBe(0);
      expect(row.energyDensity).toBeGreaterThan(0);
    }
  });

  it('solves a nominal-stress target for the stretch, in tension and compression', () => {
    let doc = addModel(withMaterial(createEmptyDocument(), 'rubber'), 'rubber', 'nh', LAWS['neoHooke'] ?? {});
    doc = defineSet(doc, 'rubber', { id: 's', hyperelastic: 'nh' }, true);
    const tension = pointResponse(doc, {
      material: 'rubber',
      kinematics: 'finite',
      steps: [{ increments: 3, control: { xx: { stress: MPa(0.7) } } }],
    });
    expect((tension.rows[0] as unknown as { stretch: number[] }).stretch[0]).toBeCloseTo(2, 9);
    const compression = pointResponse(doc, {
      material: 'rubber',
      kinematics: 'finite',
      steps: [{ increments: 3, control: { xx: { stress: MPa(-0.3) } } }],
    });
    const lambda = (compression.rows[0] as unknown as { stretch: number[] }).stretch[0] ?? 0;
    expect(lambda).toBeLessThan(1);
    expect(nominalStress(resolved('neoHooke'), 'UT', lambda)).toBeCloseTo(-0.3, 9);
    expect(tension.defaults.map((d) => d.name)).toContain('kinematicsPreset');
  });
});

describe('Ogden convention (VC-MATL-07)', () => {
  it('converts the 1972 convention to the canonical one and reports the initial shear modulus', () => {
    const stored = addModel(withMaterial(createEmptyDocument(), 'rubber'), 'rubber', 'og', LAWS['ogden1972set'] ?? {}).materials['rubber']
      ?.materialModels?.[0];
    const law = stored?.model;
    if (law?.kind !== 'hyper_ogden') throw new Error('not ogden');
    expectCase(
      PACK,
      'VC-MATL-07/ogden1972set/calculixMu',
      law.terms.map((t) => sig12(t.mu)),
    );
    expect(law.terms.map((t) => t.alpha)).toEqual([1.3, 5, -2]);
    expectCase(PACK, 'VC-MATL-07/ogden1972set/initialShearModulus', sig12(resolved('ogden1972set').shearModulus));
    expect(stored?.conversion?.from).toBe('ogden1972');
  });

  it('refuses a missing convention', () => {
    const doc = withMaterial(createEmptyDocument(), 'rubber');
    const model = { ...LAWS['ogden1972set'], convention: undefined };
    expect(codeOf(doc, 'add_material_model', { material: 'rubber', id: 'og', model, basis: 'typical', source: SOURCE })).toBe(
      'MATL_LAW_PARAMS_INVALID',
    );
  });
});

describe('Drucker scan (VC-MATL-09)', () => {
  it('finds the Ogden set stable over the whole scan', () => {
    expectCase(PACK, 'VC-MATL-09/ogden1972set/drucker', druckerScan(resolved('ogden1972set')) as never);
  });

  it('finds the first unstable stretch of Mooney-Rivlin with C01 < 0 and refuses it inside the validity', () => {
    const law = { kind: 'hyper_mooney_rivlin', C10: MPa(0.2), C01: MPa(-0.15), D1: D0 };
    const resolvedLaw = resolveHyper(law as HyperLaw);
    if (resolvedLaw === null) throw new Error('unresolved');
    expectCase(PACK, 'VC-MATL-09/mooneyRivlinNegativeC01/drucker', druckerScan(resolvedLaw) as never);
    const doc = withMaterial(createEmptyDocument(), 'rubber');
    const params = (validity: unknown[]): Record<string, unknown> => ({
      material: 'rubber',
      id: 'mr',
      model: law,
      basis: 'typical',
      source: SOURCE,
      validity,
    });
    expect(codeOf(doc, 'add_material_model', params([{ variable: 'stretch', unit: '1', data: [0.5, 3] }]))).toBe(
      'MATL_HYPERELASTIC_UNSTABLE',
    );
    const outside = run(doc, 'add_material_model', params([{ variable: 'stretch', unit: '1', data: [0.95, 1.05] }]));
    expect((outside.data as { warnings: { code: string }[] }).warnings.map((w) => w.code)).toContain('MATL_HYPERELASTIC_UNSTABLE');
    const none = run(doc, 'add_material_model', { material: 'rubber', id: 'mr', model: law, basis: 'typical', source: SOURCE });
    expect(none.rejected).toBeUndefined();
  });
});

describe('hyperelastic law validation', () => {
  const doc = withMaterial(createEmptyDocument(), 'rubber');
  const add = (model: Record<string, unknown>): string =>
    codeOf(doc, 'add_material_model', { material: 'rubber', id: 'h', model, basis: 'typical', source: SOURCE });

  it('refuses a non-positive initial shear modulus and malformed parameters', () => {
    expect(add({ kind: 'hyper_neo_hooke', C10: MPa(-0.1), D1: D0 })).toBe('MATL_HYPERELASTIC_INITIAL_MODULUS');
    expect(add({ kind: 'hyper_neo_hooke', C10: { value: 1, unit: 'K' }, D1: D0 })).toBe('MATL_LAW_PARAMS_INVALID');
    expect(add({ kind: 'hyper_neo_hooke', C10: MPa(1), D1: { value: 1, unit: 'MPa' } })).toBe('MATL_LAW_PARAMS_INVALID');
    expect(add({ kind: 'hyper_arruda_boyce', mu: MPa(0.27), lambdaM: 0.5, D: D0 })).toBe('MATL_LAW_PARAMS_INVALID');
    expect(add({ kind: 'hyper_yeoh', C10: MPa(0.18), C20: MPa(0), C30: MPa(0), D: [0, 0], compliance: '1/MPa' })).toBe(
      'MATL_LAW_PARAMS_INVALID',
    );
  });

  it('accepts polynomial and reduced polynomial laws and checks their orders', () => {
    expect(add({ kind: 'hyper_polynomial', order: 2, C: { C10: 0.2, C01: 0.05, C20: 0.001 }, D: [0, 0], stressUnit: 'MPa' })).toBe(
      'accepted',
    );
    expect(add({ kind: 'hyper_polynomial', order: 1, C: { C10: 0.2, C20: 0.001 }, D: [0], stressUnit: 'MPa' })).toBe(
      'MATL_LAW_PARAMS_INVALID',
    );
    expect(add({ kind: 'hyper_polynomial', order: 2, C: { C10: 0.2 }, D: [0], stressUnit: 'MPa' })).toBe('MATL_LAW_PARAMS_INVALID');
    expect(add({ kind: 'hyper_reduced_polynomial', order: 3, Ci0: [0.2, -0.001, 0.0001], D: [0, 0, 0], stressUnit: 'MPa' })).toBe(
      'accepted',
    );
    expect(add({ kind: 'hyper_reduced_polynomial', order: 3, Ci0: [0.2], D: [0, 0, 0], stressUnit: 'MPa' })).toBe(
      'MATL_LAW_PARAMS_INVALID',
    );
    expect(add({ kind: 'hyper_ogden', convention: 'calculix', terms: [], D: [], stressUnit: 'MPa' })).toBe('MATL_LAW_PARAMS_INVALID');
    expect(add({ kind: 'hyper_ogden', convention: 'calculix', terms: [{ mu: 1, alpha: 0 }], D: [0], stressUnit: 'MPa' })).toBe(
      'MATL_LAW_PARAMS_INVALID',
    );
  });

  it('drives compressible laws through the general finite driver and refuses unreachable paths for incompressible ones', () => {
    let local = addModel(withMaterial(createEmptyDocument(), 'rubber'), 'rubber', 'nh', {
      ...LAWS['neoHooke'],
      D1: { value: 0.01, unit: '1/MPa' },
    });
    local = defineSet(local, 'rubber', { id: 's', hyperelastic: 'nh' }, true);
    const compressible = pointResponse(local, {
      material: 'rubber',
      kinematics: 'finite',
      steps: [{ increments: 2, control: { xx: { strain: 0.5 } } }],
    }).rows[0] as unknown as { volumeRatio: number; stretch: number[] };
    expect(compressible.volumeRatio).toBeLessThan(1.2);
    expect(compressible.stretch[0]).toBeCloseTo(1.5, 12);
    let incompressible = addModel(withMaterial(createEmptyDocument(), 'rubber'), 'rubber', 'nh', LAWS['neoHooke'] ?? {});
    incompressible = defineSet(incompressible, 'rubber', { id: 's', hyperelastic: 'nh' }, true);
    const finite = (steps: unknown[], extra: Record<string, unknown> = {}): string =>
      codeOf(incompressible, 'material_point_response', { material: 'rubber', kinematics: 'finite', steps, ...extra });
    expect(finite([{ increments: 2, control: { yy: { strain: 0.5 } } }])).toBe('MATL_PATH_INVALID');
    expect(finite([{ increments: 2, control: { xx: { strain: 0.5 } } }], { preset: 'plane_strain' })).toBe('MATL_PATH_INVALID');
    expect(finite([{ increments: 2, control: { xx: { stress: MPa(1e300) } } }])).toBe('MATL_PATH_DIVERGED');
    expect(finite([])).toBe('MATL_PATH_INVALID');
    expect(
      codeOf(incompressible, 'material_point_response', {
        material: 'rubber',
        kinematics: 'small',
        set: 's',
        steps: [{ increments: 2, control: { xx: { strain: 0.01 } } }],
      }),
    ).toBe('MATL_PATH_INVALID');
  });
});
