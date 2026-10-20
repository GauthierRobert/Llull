import { describe, expect, it } from 'vitest';
import { apply, data, expectRefusal } from '../../../helpers/commandAssertions';
import { expectPure } from '../../../helpers/expectNoOp';
import { AS4, T300, pack, withMaterials } from './fixtures';

type Matrix = number[][];
interface Constants {
  Ex: number;
  Ey: number;
  Gxy: number;
  nuxy: number;
}
interface Case {
  material: string;
  angles_bottom_to_top: number[];
  thickness_mm: number;
  symmetric: boolean;
  A: Matrix;
  B: Matrix;
  D: Matrix;
  engineering_constants_membrane_A_inverse: Constants;
  engineering_constants_free_bending_ABD_inverse: Constants;
  loads: Record<
    string,
    {
      load: number[];
      first_ply_failure_multiplier: { R_max_stress: number; R_tsai_hill: number; R_tsai_wu: number };
      critical: Record<string, { ply: number; angle: number; position: string }>;
    }
  >;
}
interface Analysis {
  unit: string;
  thicknessMm: number;
  Q: Record<string, number>;
  A: Matrix;
  B: Matrix;
  D: Matrix;
  constantsMembrane: Constants;
  constantsFreeBending: Constants;
  firstPlyFailure: Record<string, { R: number; ply: number; angleDeg: number; position: string }>;
  unverified: boolean;
  reviewRequired?: boolean;
  defaults: Record<string, { value: number; defaulted: boolean }>;
}

const reference = pack<{ cases: Record<string, Case> }>('clt_reference.json').cases;
const doc = withMaterials();
const rel = (actual: number, expected: number, tolerance = 1e-4): void => {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(tolerance * Math.max(Math.abs(expected), 1e-9) + 1e-12);
};
const analyze = (angles: number[], material: string, loads?: object): Analysis =>
  data<Analysis>(doc, 'analyze_laminate', { angles, material, ...(loads === undefined ? {} : { loads }) });
const LOAD_KEYS = ['Nx', 'Ny', 'Nxy', 'Mx', 'My', 'Mxy'] as const;

describe('classical laminate theory against the published reference cases (VC-CMP-01..07)', () => {
  it('VC-CMP-01: reduced stiffness of T300/5208', () => {
    const { Q } = analyze([0], 'T300_5208');
    rel(Q['Q11'] as number, 181800, 1e-3);
    rel(Q['Q22'] as number, 10340, 1e-3);
    rel(Q['Q12'] as number, 2896.92, 1e-5);
    rel(Q['Q66'] as number, 7170, 1e-12);
  });

  it('VC-CMP-02: [0]8 reproduces E1, E2, G12 and D11 = Q11 h^3 / 12', () => {
    const result = analyze(Array(8).fill(0), 'T300_5208');
    rel(result.constantsMembrane.Ex, 181000, 1e-9);
    rel(result.constantsMembrane.Ey, 10300, 1e-9);
    rel(result.constantsMembrane.Gxy, 7170, 1e-9);
    rel(result.constantsMembrane.nuxy, 0.28, 1e-9);
    rel((result.D[0] as number[])[0] as number, 15150.9, 1e-5);
    expect(result.unit).toBe('N-mm-MPa');
  });

  it('VC-CMP-03: quasi-isotropic stacks give the same Ex, Gxy = Ex / (2 (1 + nu))', () => {
    for (const [material, ex] of [
      ['T300_5208', 69675.7],
      ['AS4_3501_6', 51061.4],
    ] as const) {
      const a = analyze([0, 45, -45, 90, 90, -45, 45, 0], material).constantsMembrane;
      const b = analyze([0, 60, -60, -60, 60, 0], material).constantsMembrane;
      rel(a.Ex, ex, 1e-5);
      rel(b.Ex, ex, 1e-5);
      rel(a.Ey, a.Ex, 1e-9);
      rel(a.Gxy, a.Ex / (2 * (1 + a.nuxy)), 1e-6);
    }
    rel(analyze([0, 45, -45, 90, 90, -45, 45, 0], 'T300_5208').A[0]?.[0] as number, 76368.2, 1e-5);
  });

  it('VC-CMP-05: an unsymmetric [0/90] pins the bottom-to-top sign and the two constant definitions', () => {
    const result = analyze([0, 90], 'T300_5208');
    rel((result.B[0] as number[])[0] as number, -1339.57, 1e-5);
    rel((result.B[1] as number[])[1] as number, 1339.57, 1e-5);
    rel(result.constantsFreeBending.Ex, 38616, 1e-4);
    rel(result.constantsMembrane.Ex, 95991.3, 1e-4);
  });

  it.each(Object.entries(reference))('%s: A, B, D, constants and first-ply failure match the reference', (key, expected) => {
    const material = expected.material;
    const result = analyze(expected.angles_bottom_to_top, material);
    rel(result.thicknessMm, expected.thickness_mm, 1e-12);
    const maxA = Math.max(...expected.A.flat().map(Math.abs));
    for (const [name, actual, wanted, scale] of [
      ['A', result.A, expected.A, maxA],
      ['B', result.B, expected.B, maxA * expected.thickness_mm],
      ['D', result.D, expected.D, maxA * expected.thickness_mm ** 2],
    ] as const)
      wanted.forEach((row, i) =>
        row.forEach((value, j) =>
          expect(Math.abs(((actual[i] as number[])[j] as number) - value), `${key} ${name}[${i}][${j}]`).toBeLessThanOrEqual(
            1e-4 * Math.max(Math.abs(value), 1e-3 * scale) + 1e-6 * scale,
          ),
        ),
      );
    for (const field of ['Ex', 'Ey', 'Gxy', 'nuxy'] as const) {
      rel(result.constantsMembrane[field], expected.engineering_constants_membrane_A_inverse[field], 2e-4);
      rel(result.constantsFreeBending[field], expected.engineering_constants_free_bending_ABD_inverse[field], 2e-4);
    }
    if (expected.symmetric)
      for (const row of result.B) for (const value of row) expect(Math.abs(value)).toBeLessThan(1e-9 * maxA * expected.thickness_mm);
    for (const loadCase of Object.values(expected.loads)) {
      const loads = Object.fromEntries(LOAD_KEYS.map((name, i) => [name, loadCase.load[i]]));
      const fpf = analyze(expected.angles_bottom_to_top, material, loads).firstPlyFailure;
      rel((fpf['max_stress'] as { R: number }).R, loadCase.first_ply_failure_multiplier.R_max_stress);
      rel((fpf['tsai_hill'] as { R: number }).R, loadCase.first_ply_failure_multiplier.R_tsai_hill);
      rel((fpf['tsai_wu'] as { R: number }).R, loadCase.first_ply_failure_multiplier.R_tsai_wu);
      expect(Math.abs((fpf['tsai_wu'] as { angleDeg: number }).angleDeg)).toBe(Math.abs(loadCase.critical['R_tsai_wu']?.angle ?? NaN));
    }
  });

  it('VC-CMP-06: all criteria give Xt h for [0]8 under Nx, Yt h under Ny and S h under Nxy', () => {
    const angles = Array(8).fill(0);
    const nx = analyze(angles, 'T300_5208', { Nx: 1 }).firstPlyFailure;
    for (const name of ['max_stress', 'tsai_hill', 'tsai_wu']) rel((nx[name] as { R: number }).R, 1500, 1e-9);
    const ny = analyze(angles, 'T300_5208', { Ny: 1 }).firstPlyFailure;
    for (const name of ['max_stress', 'tsai_hill', 'tsai_wu']) rel((ny[name] as { R: number }).R, 40, 1e-9);
    rel((analyze(angles, 'T300_5208', { Nxy: 1 }).firstPlyFailure['max_stress'] as { R: number }).R, 68, 1e-9);
    rel((analyze(angles, 'AS4_3501_6', { Nx: 1 }).firstPlyFailure['tsai_wu'] as { R: number }).R, 1950, 1e-9);
  });

  it('VC-CMP-07: the critical ply of [0/45/-45/90]s is the 90 ply and [+-45]s is shear governed', () => {
    const qi = analyze([0, 45, -45, 90, 90, -45, 45, 0], 'T300_5208', { Nx: 1 }).firstPlyFailure;
    expect((qi['tsai_wu'] as { angleDeg: number }).angleDeg).toBe(90);
    rel((qi['tsai_wu'] as { R: number }).R, 276.119, 1e-4);
    const pm45 = analyze([45, -45, -45, 45], 'T300_5208', { Nx: 1 }).firstPlyFailure;
    expect((pm45['max_stress'] as { mode: string }).mode).toBe('shear');
  });

  it('labels first-ply failure results as needing review and reports the F12* default', () => {
    const result = analyze([0, 90, 90, 0], 'T300_5208', { Nx: 100 });
    expect(result.reviewRequired).toBe(true);
    expect(result.defaults['tsaiWuF12Star']).toMatchObject({ value: -0.5, defaulted: true });
    expect(analyze([0, 90, 90, 0], 'T300_5208').reviewRequired).toBeUndefined();
  });

  it('VC-CMP-35: mean-basis data marks every result unverified', () => {
    expect(analyze([0, 90, 90, 0], 'AS4_3501_6').unverified).toBe(true);
    expect(analyze([0, 90, 90, 0], 'T300_5208').unverified).toBe(false);
  });

  it('accepts a stacking string and converts thickness from other document units', () => {
    const fromString = data<Analysis>(doc, 'analyze_laminate', { laminate: '[0/45/-45/90]s', material: 'T300_5208' });
    rel(fromString.constantsMembrane.Ex, 69675.7, 1e-5);
    const inCm = apply(apply(doc, 'set_units', { units: 'cm' }), 'create_lamina_material', { ...T300, plyThickness: 0.0125 });
    rel(data<Analysis>(inCm, 'analyze_laminate', { laminate: '[0/45/-45/90]s', material: 'T300_5208' }).thicknessMm, 1, 1e-12);
  });

  it('refuses bad inputs with stable codes', () => {
    expectRefusal(doc, 'analyze_laminate', { angles: [0], material: 'nope' }, 'CMP_REF_MISSING');
    expectRefusal(doc, 'analyze_laminate', { laminate: '[0/9O]s', material: 'T300_5208' }, 'CMP_NOTATION_PARSE');
    expectRefusal(doc, 'analyze_laminate', { material: 'T300_5208' }, 'CMP_PARAM_INVALID');
    expectRefusal(doc, 'analyze_laminate', { part: 'nope', point: [0, 0, 0] }, 'CMP_REF_MISSING');
    const noStrength = apply(doc, 'create_lamina_material', {
      name: 'weak',
      form: 'ud_tape',
      E1: 100000,
      E2: 8000,
      G12: 4000,
      nu12: 0.3,
      plyThickness: 0.2,
      source: 'test',
    });
    expectRefusal(
      noStrength,
      'analyze_laminate',
      { angles: [0, 90], material: 'weak', loads: { Nx: 1 } },
      'CMP_MATERIAL_ALLOWABLE_MISSING',
    );
    expect(data<Analysis>(noStrength, 'analyze_laminate', { angles: [0, 90], material: 'weak' }).unverified).toBe(true);
  });

  it('refuses a singular laminate', () => {
    const rigid = apply(doc, 'create_lamina_material', { ...AS4, name: 'tiny', E1: 1e-3, E2: 1e12, nu12: 0, G12: 1e-3 });
    expectRefusal(rigid, 'analyze_laminate', { angles: [0], material: 'tiny' }, 'CMP_LAMINATE_SINGULAR');
  });

  it('is pure', () => {
    expectPure(doc, () => analyze([0, 90], 'T300_5208', { Nx: 1 }));
  });
});
