/**
 * Numerics of the linearisation (13 FLT M5): the eigenvalue solver against matrices with known spectra, the central-difference Jacobian against a
 * linear system with a known A and B, and the mode labels against hand-built state matrices.
 */
import { describe, expect, it } from 'vitest';
import { eigenvalues } from '@dynamics/flight/eigenvalues';
import { analyseModes } from '@dynamics/flight/flightModes';
import { centralJacobian } from '@dynamics/flight/linearModel';

const sorted = (values: readonly { re: number; im: number }[]): number[][] => values.map((value) => [value.re, value.im]);

describe('eigenvalues (nonsymmetric, real)', () => {
  it('triangular and diagonal matrices give their diagonal', () => {
    const values = eigenvalues([
      [3, 1, 4],
      [0, -2, 5],
      [0, 0, 0.5],
    ]);
    expect(values?.map((value) => value.re)).toEqual([3, 0.5, -2]);
    expect(eigenvalues([])).toEqual([]);
  });

  it('a rotation block gives the conjugate pair, the companion of (s + 1)(s^2 + 2s + 5) gives -1, -1 ± 2i', () => {
    const rotation = eigenvalues([
      [0, -2],
      [2, 0],
    ]);
    expect(sorted(rotation ?? [])).toEqual([
      [0, 2],
      [0, -2],
    ]);
    // s^3 + 3 s^2 + 7 s + 5
    const companion = eigenvalues([
      [0, 1, 0],
      [0, 0, 1],
      [-5, -7, -3],
    ]);
    const [first, second, third] = [...(companion ?? [])].sort((x, y) => y.im - x.im);
    expect(first?.re).toBeCloseTo(-1, 9);
    expect(first?.im).toBeCloseTo(2, 9);
    expect(second?.re).toBeCloseTo(-1, 9);
    expect(second?.im).toBeCloseTo(0, 9);
    expect(third?.im).toBeCloseTo(-2, 9);
  });

  it('a similarity transform of a known spectrum (a 6 x 6 with badly scaled rows) keeps it', () => {
    const base = [
      [-0.5, 3, 0, 0, 0, 0],
      [-3, -0.5, 0, 0, 0, 0],
      [0, 0, -4, 0, 0, 0],
      [0, 0, 0, 1.5, 6, 0],
      [0, 0, 0, -6, 1.5, 0],
      [0, 0, 0, 0, 0, 0],
    ];
    const scale = [1, 1e3, 1e-3, 1e4, 1e-2, 1];
    const scaled = base.map((row, i) => row.map((value, j) => (value * (scale[i] ?? 1)) / (scale[j] ?? 1)));
    const values = eigenvalues(scaled) ?? [];
    const real = values.map((value) => value.re).sort((x, y) => x - y);
    expect(real[0]).toBeCloseTo(-4, 6);
    expect(real[1]).toBeCloseTo(-0.5, 6);
    expect(real[3]).toBeCloseTo(0, 6);
    expect(real[5]).toBeCloseTo(1.5, 6);
    expect(Math.max(...values.map((value) => Math.abs(value.im)))).toBeCloseTo(6, 6);
  });

  it('a non-finite or ragged matrix is null; a 1 x 1 and a defective Jordan block are handled', () => {
    expect(eigenvalues([[Number.NaN]])).toBeNull();
    expect(eigenvalues([[1, 2], [3]])).toBeNull();
    expect(eigenvalues([[-7]])).toEqual([{ re: -7, im: 0 }]);
    const jordan = eigenvalues([
      [2, 1],
      [0, 2],
    ]);
    expect(jordan?.map((value) => value.re)).toEqual([2, 2]);
  });
});

describe('centralJacobian', () => {
  it('returns the A and B of a linear system x-dot = A x + B u to round-off (the oracle of the linearisation)', () => {
    const a = [
      [-1, 2, 0.5],
      [0, -3, 4],
      [7, 0, -0.25],
    ];
    const b = [[1], [0], [-2]];
    const f = (z: readonly number[]): number[] =>
      a.map((row, i) => row.reduce((sum, value, j) => sum + value * (z[j] ?? 0), 0) + (b[i]?.[0] ?? 0) * (z[3] ?? 0));
    const jacobian = centralJacobian(f, [0.3, -1, 2, 0.5], [1e-3, 1e-3, 1e-3, 1e-3]);
    a.forEach((row, i) => row.forEach((value, j) => expect(jacobian[i]?.[j]).toBeCloseTo(value, 9)));
    b.forEach((row, i) => expect(jacobian[i]?.[3]).toBeCloseTo(row[0] ?? 0, 9));
  });
});

/** An 8 x 8 state matrix (u, v, w, p, q, r, roll, pitch) from a longitudinal and a lateral 4 x 4 block. */
function stateMatrix(longitudinal: number[][], lateral: number[][]): number[][] {
  const lon = [0, 2, 4, 7];
  const lat = [1, 3, 5, 6];
  const a = Array.from({ length: 8 }, () => Array.from({ length: 8 }, () => 0));
  lon.forEach((i, r) => lon.forEach((j, c) => ((a[i] as number[])[j] = longitudinal[r]?.[c] ?? 0)));
  lat.forEach((i, r) => lat.forEach((j, c) => ((a[i] as number[])[j] = lateral[r]?.[c] ?? 0)));
  return a;
}

describe('mode labels', () => {
  it('fixed wing: phugoid < short period, Dutch roll pair, roll subsidence = fastest real, spiral = slowest real', () => {
    const slow = [
      [-0.02, 0.7, 0, 0],
      [-0.7, -0.02, 0, 0],
      [0, 0, -3, 5],
      [0, 0, -5, -3],
    ];
    const lateral = [
      [-1, 0, 0, 0],
      [0, -8, 0, 0],
      [0, 0, -0.5, 4],
      [0, 0, -4, -0.5],
    ];
    const modes = analyseModes(stateMatrix(slow, lateral), 'fixed_wing')?.modes ?? [];
    const byLabel = Object.fromEntries(modes.map((mode) => [mode.label, mode]));
    expect(byLabel['phugoid']?.im).toBeCloseTo(0.7, 9);
    expect(byLabel['phugoid']?.dampingRatio).toBeCloseTo(0.02 / Math.hypot(0.02, 0.7), 9);
    expect(byLabel['short_period']?.im).toBeCloseTo(5, 9);
    expect(byLabel['dutch_roll']?.periodS).toBeCloseTo((2 * Math.PI) / 4, 9);
    expect(byLabel['roll_subsidence']?.re).toBeCloseTo(-8, 9);
    expect(byLabel['roll_subsidence']?.timeConstantS).toBeCloseTo(0.125, 9);
    expect(byLabel['spiral']?.re).toBeCloseTo(-1, 9);
    expect(modes.every((mode) => mode.stability === 'stable')).toBe(true);
  });

  it('an unstable spiral is flagged with its time to double; a lone longitudinal pair slower than the real roots is the phugoid', () => {
    const longitudinal = [
      [-0.02, 0.7, 0, 0],
      [-0.7, -0.02, 0, 0],
      [0, 0, -9, 0],
      [0, 0, 0, -12],
    ];
    const lateral = [
      [0.04, 0, 0, 0],
      [0, -6, 0, 0],
      [0, 0, -2, 0],
      [0, 0, 0, -3],
    ];
    const analysed = analyseModes(stateMatrix(longitudinal, lateral), 'fixed_wing');
    const spiral = analysed?.modes.find((mode) => mode.label === 'spiral');
    expect(spiral?.stability).toBe('unstable');
    expect(spiral?.timeToDoubleS).toBeCloseTo(Math.LN2 / 0.04, 9);
    expect(analysed?.modes.find((mode) => mode.label === 'phugoid')).toBeDefined();
    expect(analysed?.modes.filter((mode) => mode.label === 'longitudinal_real')).toHaveLength(2);
    expect(analysed?.modes.filter((mode) => mode.label === 'lateral_real')).toHaveLength(2);
    expect(analysed?.couplingRatio).toBe(0);
  });

  it('a lone fast pair beside slower real roots is the short period; two lateral pairs both read as Dutch roll', () => {
    const longitudinal = [
      [-0.05, 0, 0, 0],
      [0, -0.2, 0, 0],
      [0, 0, -3, 5],
      [0, 0, -5, -3],
    ];
    const analysed = analyseModes(
      stateMatrix(longitudinal, [
        [-1, 3, 0, 0],
        [-3, -1, 0, 0],
        [0, 0, -2, 6],
        [0, 0, -6, -2],
      ]),
      'fixed_wing',
    );
    expect(analysed?.modes.filter((mode) => mode.label === 'short_period')).toHaveLength(1);
    expect(analysed?.modes.filter((mode) => mode.label === 'dutch_roll')).toHaveLength(2);
  });

  it('hover: heave is the real longitudinal root nearest A[w][w], yaw the real lateral root nearest A[r][r], the chains are translations', () => {
    const a = stateMatrix(
      [
        [0, 0, 0, -9.8],
        [0, -0.4, 0, 0],
        [0, 0, 0, -1],
        [0, 0, 0, 0],
      ],
      [
        [0, 0, 0, -9.8],
        [0, 0, 0, 1],
        [0, 0, -0.3, 0],
        [0, 1, 0, 0],
      ],
    );
    const modes = analyseModes(a, 'hover')?.modes ?? [];
    expect(modes.filter((mode) => mode.label === 'heave')).toHaveLength(1);
    expect(modes.find((mode) => mode.label === 'heave')?.re).toBeCloseTo(-0.4, 6);
    expect(modes.find((mode) => mode.label === 'yaw')?.re).toBeCloseTo(-0.3, 6);
    expect(modes.filter((mode) => mode.label === 'pitch_translation').length).toBeGreaterThan(0);
    expect(modes.filter((mode) => mode.label === 'roll_translation').length).toBeGreaterThan(0);
  });

  it('strong longitudinal-lateral coupling leaves a full-matrix root with no block root within 10 %: labelled coupled, couplingRatio > 0', () => {
    const a = stateMatrix(
      [
        [-1, 0, 0, 0],
        [0, -2, 0, 0],
        [0, 0, -3, 0],
        [0, 0, 0, -4],
      ],
      [
        [-5, 0, 0, 0],
        [0, -6, 0, 0],
        [0, 0, -7, 0],
        [0, 0, 0, -8],
      ],
    );
    (a[0] as number[])[5] = 30;
    (a[5] as number[])[0] = -30;
    const coupled = analyseModes(a, 'fixed_wing');
    expect(coupled?.couplingRatio).toBeGreaterThan(0.1);
    expect(coupled?.modes.some((mode) => mode.label === 'coupled')).toBe(true);
  });

  it('a non-finite state matrix has no analysis', () => {
    const a = stateMatrix([], []);
    (a[0] as number[])[0] = Number.NaN;
    expect(analyseModes(a, 'hover')).toBeNull();
  });
});
