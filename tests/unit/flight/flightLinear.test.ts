/**
 * Numerics of the linearisation (13 FLT M5): the eigenvalue solver against matrices with known spectra and its iteration limit, and the
 * central-difference Jacobian against a linear system with a known A and B (mode labels: flightModeLabels.test.ts).
 */
import { describe, expect, it } from 'vitest';
import { eigenvalues } from '@dynamics/flight/eigenvalues';
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

  it('the cyclic permutation (on which the Francis shift stalls) converges through the exceptional shifts to the cube roots of unity', () => {
    const values = eigenvalues([
      [0, 0, 1],
      [1, 0, 0],
      [0, 1, 0],
    ]);
    const [one, upper, lower] = values ?? [];
    expect(one?.re).toBeCloseTo(1, 9);
    expect(one?.im).toBeCloseTo(0, 9);
    expect(upper?.re).toBeCloseTo(-0.5, 9);
    expect(upper?.im).toBeCloseTo(Math.sqrt(3) / 2, 9);
    expect(lower?.im).toBeCloseTo(-Math.sqrt(3) / 2, 9);
  });

  it('an iteration that exhausts its sweep limit is non-convergence: null, never a partial spectrum', () => {
    const companion = [
      [0, 1, 0],
      [0, 0, 1],
      [-5, -7, -3],
    ];
    expect(eigenvalues(companion, 0)).toBeNull();
    expect(eigenvalues(companion, 1)).toBeNull();
    // 1 x 1 and 2 x 2 blocks deflate without a sweep, so they need none
    expect(eigenvalues([[4]], 0)).toEqual([{ re: 4, im: 0 }]);
    expect(eigenvalues(companion)).toHaveLength(3);
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

  it('a step missing for a variable is an invariant breach (RangeError), never a silent zero column', () => {
    expect(() => centralJacobian((z) => z, [1, 2], [1e-3])).toThrow(RangeError);
  });

  it('outputs of unequal length fill the missing derivatives with zero: one row per output of the longest evaluation', () => {
    // two outputs above x0 = 0, one below: d f_1 / dx reads the missing lower value as 0
    const f = (z: readonly number[]): number[] => ((z[0] ?? 0) > 0 ? [3 * (z[0] ?? 0), 5] : [3 * (z[0] ?? 0)]);
    const jacobian = centralJacobian(f, [0], [0.5]);
    expect(jacobian).toHaveLength(2);
    expect(jacobian[0]?.[0]).toBeCloseTo(3, 12);
    expect(jacobian[1]?.[0]).toBeCloseTo(5, 12);
    // a variable whose evaluations have fewer outputs than another's leaves 0 in its shorter column
    const ragged = centralJacobian((z) => ((z[1] ?? 0) === 0 ? [z[0] ?? 0, 1] : [z[1] ?? 0]), [0, 0], [0.25, 0.25]);
    expect(ragged).toEqual([
      [1, 1],
      [0, 0],
    ]);
  });
});
