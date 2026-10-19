/** M7: compressible hyperelastic laws in the finite-strain driver (volumetric terms U(J), general paths, lateral contraction by Newton). */
import { describe, expect, it } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import { codeOf, pointResponse, withMaterial, MPa } from './materialFixtures';

interface Row {
  strain: number[];
  stress: number[];
  stretch: number[];
  nominalStress: number;
  volumeRatio: number;
  energyDensity: number;
}
const doc = withMaterial(createEmptyDocument(), 'rubber');
const inv = (value: number, unit = '1/MPa'): { value: number; unit: string } => ({ value, unit });

const point = (model: Record<string, unknown>, steps: unknown[], extra: Record<string, unknown> = {}): Row[] =>
  pointResponse(doc, { material: 'rubber', kinematics: 'finite', model, steps, ...extra }).rows as unknown as Row[];

const NH = { kind: 'hyper_neo_hooke', C10: MPa(0.5), D1: inv(0.02) };
const mu = 2 * 0.5;
const K = 2 / 0.02;

describe('volumetric response', () => {
  it('hydrostatic stretch gives the pressure U′(J) = (2/D1)(J − 1) and energy (1/D1)(J − 1)²', () => {
    const [row] = point(NH, [{ increments: 4, control: { xx: { strain: 0.1 }, yy: { strain: 0.1 }, zz: { strain: 0.1 } } }]);
    const J = 1.1 ** 3;
    expect(row?.volumeRatio).toBeCloseTo(J, 12);
    expect(row?.stress[0]).toBeCloseTo((2 / 0.02) * (J - 1), 9);
    expect(row?.stress[1]).toBeCloseTo(row?.stress[0] ?? Number.NaN, 12);
    expect(Math.abs(row?.stress[3] ?? 1)).toBeLessThan(1e-12);
    expect(row?.energyDensity).toBeCloseTo((J - 1) ** 2 / 0.02, 9);
  });

  it('holds the volumetric form of every law family: Mooney-Rivlin, Yeoh, polynomial, reduced polynomial, Ogden, Arruda-Boyce', () => {
    const hydro = [{ increments: 2, control: { xx: { strain: 0.05 }, yy: { strain: 0.05 }, zz: { strain: 0.05 } } }];
    const J = 1.05 ** 3;
    const pressure = (...d: number[]): number =>
      d.reduce((sum, di, i) => sum + (di > 0 ? ((2 * (i + 1)) / di) * (J - 1) ** (2 * i + 1) : 0), 0);
    const cases: [Record<string, unknown>, number][] = [
      [{ kind: 'hyper_mooney_rivlin', C10: MPa(0.4), C01: MPa(0.1), D1: inv(0.02) }, pressure(0.02)],
      [
        { kind: 'hyper_yeoh', C10: MPa(0.4), C20: MPa(-0.01), C30: MPa(0.001), D: [0.02, 0.01, 0.005], compliance: '1/MPa' },
        pressure(0.02, 0.01, 0.005),
      ],
      [
        { kind: 'hyper_polynomial', order: 2, C: { C10: 0.4, C01: 0.1, C11: 0.01 }, D: [0.02, 0.01], stressUnit: 'MPa' },
        pressure(0.02, 0.01),
      ],
      [{ kind: 'hyper_reduced_polynomial', order: 2, Ci0: [0.4, -0.01], D: [0.02, 0.01], stressUnit: 'MPa' }, pressure(0.02, 0.01)],
      [{ kind: 'hyper_ogden', convention: 'calculix', terms: [{ mu: 0.4, alpha: 2 }], D: [0.02], stressUnit: 'MPa' }, pressure(0.02)],
      [{ kind: 'hyper_arruda_boyce', mu: MPa(0.3), lambdaM: 3, D: inv(0.02) }, (J - 1 / J) / 0.02],
    ];
    for (const [model, expected] of cases) {
      const [row] = point(model, hydro);
      expect(row?.stress[0], String(model['kind'])).toBeCloseTo(expected, 8);
    }
  });

  it('reads D in the reciprocal of the stated stress unit', () => {
    const kPa = point({ kind: 'hyper_ogden', convention: 'calculix', terms: [{ mu: 400, alpha: 2 }], D: [2e-5], stressUnit: 'kPa' }, [
      { increments: 2, control: { xx: { strain: 0.05 }, yy: { strain: 0.05 }, zz: { strain: 0.05 } } },
    ]);
    const J = 1.05 ** 3;
    expect(kPa[0]?.stress[0]).toBeCloseTo((2 / 0.02) * (J - 1), 8);
  });
});

describe('uniaxial paths with free lateral contraction', () => {
  it('matches an independent solution of σ_lateral = 0 for compressible Neo-Hooke', () => {
    const lambda = 1.5;
    const stress = (lateral: number): { axial: number; side: number; J: number } => {
      const J = lambda * lateral * lateral;
      const bar = [lambda, lateral, lateral].map((x) => x * J ** (-1 / 3));
      const i1 = bar.reduce((s, x) => s + x * x, 0);
      const dev = bar.map((x) => ((2 * 0.5) / J) * (x * x - i1 / 3) + (2 / 0.02) * (J - 1));
      return { axial: dev[0] ?? 0, side: dev[1] ?? 0, J };
    };
    let lo = 0.3;
    let hi = 1.2;
    for (let i = 0; i < 200; i += 1) {
      const mid = 0.5 * (lo + hi);
      if (stress(mid).side > 0) hi = mid;
      else lo = mid;
    }
    const lateral = 0.5 * (lo + hi);
    const [row] = point(NH, [{ increments: 5, control: { xx: { strain: 0.5 } } }]);
    expect(row?.stress[0]).toBeCloseTo(stress(lateral).axial, 8);
    expect(row?.volumeRatio).toBeCloseTo(stress(lateral).J, 9);
    expect(Math.abs(row?.stress[1] ?? 1)).toBeLessThan(1e-9);
    expect(Math.abs(row?.stress[2] ?? 1)).toBeLessThan(1e-9);
    expect(row?.nominalStress).toBeCloseTo((stress(lateral).J * stress(lateral).axial) / lambda, 8);
    expect(row?.strain[1]).toBeCloseTo(Math.log(lateral), 9);
  });

  it('recovers the small-strain Young modulus E = 9KG/(3K + G) and ν = (3K − 2G)/(2(3K + G))', () => {
    const e = 1e-6;
    const [row] = point(NH, [{ increments: 1, control: { xx: { strain: e } } }]);
    const E = (9 * K * mu) / (3 * K + mu);
    const nu = (3 * K - 2 * mu) / (2 * (3 * K + mu));
    expect((row?.stress[0] ?? 0) / e).toBeCloseTo(E, 4);
    expect(-(row?.strain[1] ?? 0) / e).toBeCloseTo(nu, 5);
  });

  it('a stress-controlled path is the inverse of the strain-controlled one', () => {
    const [byStrain] = point(NH, [{ increments: 5, control: { xx: { strain: 0.5 } } }]);
    const [byStress] = point(NH, [{ increments: 5, control: { xx: { stress: MPa(byStrain?.nominalStress ?? 0) } } }]);
    expect(byStress?.stretch[0]).toBeCloseTo(byStrain?.stretch[0] ?? Number.NaN, 8);
    expect(byStress?.volumeRatio).toBeCloseTo(byStrain?.volumeRatio ?? Number.NaN, 8);
  });

  it('tends to the incompressible solution as D1 → 0 (K = 2e6 MPa; nominal stress 0.7 MPa at λ = 2 for C10 = 0.2)', () => {
    const [row] = point({ kind: 'hyper_neo_hooke', C10: MPa(0.2), D1: inv(1e-6) }, [{ increments: 4, control: { xx: { strain: 1 } } }]);
    expect(row?.nominalStress).toBeCloseTo(0.7, 4);
    expect(row?.volumeRatio).toBeCloseTo(1, 5);
  });

  it('compressible Ogden recovers E from the sum of the shear terms', () => {
    const e = 1e-6;
    const [row] = point(
      {
        kind: 'hyper_ogden',
        convention: 'calculix',
        terms: [
          { mu: 0.3, alpha: 2 },
          { mu: 0.2, alpha: -3 },
        ],
        D: [0.02, 0],
        stressUnit: 'MPa',
      },
      [{ increments: 1, control: { xx: { strain: e } } }],
    );
    const G = 0.5;
    expect((row?.stress[0] ?? 0) / e).toBeCloseTo((9 * K * G) / (3 * K + G), 4);
  });
});

describe('general paths', () => {
  it('simple shear of Neo-Hooke gives σ12 = μ γ and the first normal stress difference μ γ² (J = 1)', () => {
    const gamma = 0.8;
    const [row] = point(
      { kind: 'hyper_neo_hooke', C10: MPa(0.5), D1: inv(0.02) },
      [{ increments: 8, control: { xy: { strain: gamma } } }],
      { preset: 'simple_shear' },
    );
    expect(row?.stress[3]).toBeCloseTo(mu * gamma, 9);
    expect((row?.stress[0] ?? 0) - (row?.stress[1] ?? 0)).toBeCloseTo(mu * gamma * gamma, 9);
    expect(row?.volumeRatio).toBeCloseTo(1, 12);
    expect(row?.strain[3]).toBeGreaterThan(0);
  });

  it('equibiaxial and pure-shear presets hold their constraints; the biaxial stress is the same in both directions', () => {
    const [eq] = point(NH, [{ increments: 4, control: { xx: { strain: 0.3 } } }], { preset: 'equibiaxial' });
    expect(eq?.stress[0]).toBeCloseTo(eq?.stress[1] ?? Number.NaN, 10);
    expect(Math.abs(eq?.stress[2] ?? 1)).toBeLessThan(1e-9);
    const [ps] = point(NH, [{ increments: 4, control: { xx: { strain: 0.3 } } }], { preset: 'pure_shear' });
    expect(ps?.strain[1]).toBeCloseTo(0, 12);
    expect(Math.abs(ps?.stress[2] ?? 1)).toBeLessThan(1e-9);
    expect(ps?.stress[1]).toBeGreaterThan(0);
  });

  it('uniaxial strain (all lateral stretches held) loads volumetrically with the constrained modulus K + 4G/3 at small strain', () => {
    const e = 1e-6;
    const [row] = point(NH, [{ increments: 1, control: { xx: { strain: e } } }], { preset: 'uniaxial_strain' });
    expect((row?.stress[0] ?? 0) / e).toBeCloseTo(K + (4 * mu) / 3, 3);
  });

  it('reports every increment on request and the energy grows monotonically in tension', () => {
    const rows = point(NH, [{ increments: 6, control: { xx: { strain: 0.6 } } }], { output: 'increments' });
    expect(rows).toHaveLength(6);
    rows.slice(1).forEach((row, i) => expect(row.energyDensity).toBeGreaterThan(rows[i]?.energyDensity ?? Number.POSITIVE_INFINITY));
  });

  it('does not touch the document', () => {
    const before = JSON.stringify(doc);
    point(NH, [{ increments: 2, control: { xx: { strain: 0.2 } } }]);
    expect(JSON.stringify(doc)).toBe(before);
  });
});

describe('refusals', () => {
  const request = (model: Record<string, unknown>, steps: unknown[], extra: Record<string, unknown> = {}): string =>
    codeOf(doc, 'material_point_response', { material: 'rubber', kinematics: 'finite', model, steps, ...extra });

  it('MATL_PATH_DIVERGED when the stretch would invert the material', () => {
    expect(request(NH, [{ increments: 2, control: { xx: { strain: -1.5 } } }])).toBe('MATL_PATH_DIVERGED');
  });

  it('MATL_PATH_DIVERGED when a stress target is not reachable by Newton from the reference', () => {
    expect(
      request({ kind: 'hyper_neo_hooke', C10: MPa(0.5), D1: inv(0.02) }, [{ increments: 1, control: { xx: { stress: MPa(-1e6) } } }]),
    ).toBe('MATL_PATH_DIVERGED');
  });

  it('MATL_LAW_PARAMS_INVALID for D1 = 0 with a higher D_i > 0, and for a malformed increment count', () => {
    expect(
      request({ kind: 'hyper_yeoh', C10: MPa(0.4), C20: MPa(0), C30: MPa(0), D: [0, 0.01, 0], compliance: '1/MPa' }, [
        { increments: 1, control: { xx: { strain: 0.1 } } },
      ]),
    ).toBe('MATL_LAW_PARAMS_INVALID');
    expect(request(NH, [{ increments: 0, control: { xx: { strain: 0.1 } } }])).toBe('MATL_PATH_INVALID');
  });

  it('keeps refusing shear presets for incompressible laws (homogeneous modes only)', () => {
    expect(
      request({ kind: 'hyper_neo_hooke', C10: MPa(0.5), D1: inv(0) }, [{ control: { xx: { strain: 0.1 } } }], { preset: 'simple_shear' }),
    ).toBe('MATL_PATH_INVALID');
  });
});
