/** BiCGSTAB for non-symmetric systems and the stall check of the conjugate gradient (the solvers of the harmonic map, TECHNICAL_SPEC 13.23). */

import { describe, expect, it } from 'vitest';
import { biCgStab } from '@lib/biCgStab';
import { conjugateGradient } from '@lib/conjugateGradient';

/** A tridiagonal operator with the diagonal `d` and off-diagonals `lower`, `upper` (symmetric when they are equal). */
const tridiagonal =
  (d: number, lower: number, upper: number) =>
  (x: Float64Array, out: Float64Array): void => {
    for (let i = 0; i < x.length; i++)
      out[i] = d * (x[i] as number) + (i > 0 ? lower * (x[i - 1] as number) : 0) + (i + 1 < x.length ? upper * (x[i + 1] as number) : 0);
  };
const diagonalOf = (n: number, d: number): Float64Array => new Float64Array(n).fill(d);

describe('biCgStab', () => {
  it('solves a non-symmetric tridiagonal system to the tolerance, from a cold and from a warm start', () => {
    const n = 200;
    const apply = tridiagonal(4, -1, -2);
    const exact = Float64Array.from({ length: n }, (_, i) => Math.sin(i / 7));
    const b = new Float64Array(n);
    apply(exact, b);
    const cold = biCgStab(apply, b, new Float64Array(n), { maxIterations: 500, tolerance: 1e-12, diagonal: diagonalOf(n, 4) });
    expect(cold.converged).toBe(true);
    expect(Math.max(...cold.x.map((v, i) => Math.abs(v - (exact[i] as number))))).toBeLessThan(1e-9);
    const warm = biCgStab(apply, b, cold.x, { maxIterations: 500, tolerance: 1e-12, diagonal: diagonalOf(n, 4) });
    expect(warm.iterations).toBe(0);
    expect(warm.converged).toBe(true);
  });

  it('a zero right-hand side is the zero solution; the cap and the stall check end it unconverged', () => {
    const n = 50;
    const apply = tridiagonal(2.0001, -1, -1);
    expect(biCgStab(apply, new Float64Array(n), new Float64Array(n).fill(1), { maxIterations: 10, tolerance: 1e-9 })).toMatchObject({
      iterations: 0,
      converged: true,
    });
    const b = Float64Array.from({ length: n }, (_, i) => 1 + (i % 3));
    const capped = biCgStab(apply, b, new Float64Array(n), { maxIterations: 3, tolerance: 1e-14 });
    expect(capped.converged).toBe(false);
    expect(capped.iterations).toBe(3);
    // a singular operator never improves: the stall check ends it long before the cap
    const stalled = biCgStab((_x, out) => out.fill(0), b, new Float64Array(n), { maxIterations: 100_000, tolerance: 1e-9, stallWindow: 5 });
    expect(stalled.converged).toBe(false);
    expect(stalled.iterations).toBeLessThan(10);
  });
});

describe('conjugateGradient stallWindow', () => {
  it('without it the solve is unchanged; with it a solve whose residual stops falling ends at the check', () => {
    const n = 100;
    const apply = tridiagonal(2.01, -1, -1);
    const b = Float64Array.from({ length: n }, (_, i) => Math.cos(i));
    const plain = conjugateGradient(apply, b, new Float64Array(n), { maxIterations: 1000, tolerance: 1e-10 });
    const checked = conjugateGradient(apply, b, new Float64Array(n), { maxIterations: 1000, tolerance: 1e-10, stallWindow: 1000 });
    expect(checked.x).toEqual(plain.x);
    expect(checked.iterations).toBe(plain.iterations);
    // an ill-conditioned system: CG's residual does not fall steadily, so a short window ends the solve before it converges
    const hard = tridiagonal(2.0001, -1, -1);
    const rhs = Float64Array.from({ length: 300 }, (_, i) => Math.cos(i * 1.3));
    const full = conjugateGradient(hard, rhs, new Float64Array(300), { maxIterations: 5000, tolerance: 1e-10 });
    const cut = conjugateGradient(hard, rhs, new Float64Array(300), { maxIterations: 5000, tolerance: 1e-10, stallWindow: 4 });
    expect(full.converged).toBe(true);
    expect(cut.converged).toBe(false);
    expect(cut.iterations).toBeLessThan(full.iterations);
  });
});
