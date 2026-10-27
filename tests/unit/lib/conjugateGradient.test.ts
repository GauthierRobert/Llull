import { describe, expect, it } from 'vitest';
import { conjugateGradient } from '@lib/conjugateGradient';

const dense =
  (a: number[][]) =>
  (x: Float64Array, out: Float64Array): void => {
    a.forEach((row, i) => (out[i] = row.reduce((total, value, j) => total + value * (x[j] as number), 0)));
  };

describe('conjugateGradient', () => {
  const spd = [
    [4, 1, 0],
    [1, 3, 1],
    [0, 1, 2],
  ];

  it('solves a symmetric positive definite system to the analytic solution, with or without the Jacobi preconditioner', () => {
    const exact = [1, -2, 3];
    const b = Float64Array.from(spd.map((row) => row.reduce((total, value, j) => total + value * (exact[j] as number), 0)));
    for (const diagonal of [undefined, Float64Array.from([4, 3, 2])]) {
      const result = conjugateGradient(dense(spd), b, new Float64Array(3), { maxIterations: 20, tolerance: 1e-12, diagonal });
      expect(result.converged).toBe(true);
      expect(result.iterations).toBeLessThanOrEqual(3);
      exact.forEach((value, i) => expect(result.x[i]).toBeCloseTo(value, 10));
      expect(result.relativeResidual).toBeLessThanOrEqual(1e-12);
    }
  });

  it('solves a singular but consistent system (a solution exists) and reaches the residual tolerance', () => {
    const singular = [
      [1, 1],
      [1, 1],
    ];
    const b = Float64Array.from([2, 2]);
    const result = conjugateGradient(dense(singular), b, new Float64Array(2), { maxIterations: 10, tolerance: 1e-12 });
    expect(result.converged).toBe(true);
    expect((result.x[0] as number) + (result.x[1] as number)).toBeCloseTo(2, 12);
  });

  it('returns zero at once for b = 0, whatever the warm start', () => {
    const result = conjugateGradient(dense(spd), new Float64Array(3), Float64Array.from([5, 5, 5]), { maxIterations: 5, tolerance: 1e-12 });
    expect(Array.from(result.x)).toEqual([0, 0, 0]);
    expect(result).toMatchObject({ iterations: 0, converged: true, relativeResidual: 0 });
  });

  it('a warm start at the solution needs no iteration, and a near start fewer than a cold one', () => {
    const exact = Float64Array.from([1, -2, 3]);
    const b = new Float64Array(3);
    dense(spd)(exact, b);
    const atSolution = conjugateGradient(dense(spd), b, exact, { maxIterations: 20, tolerance: 1e-12 });
    expect(atSolution.iterations).toBe(0);
    const n = 40;
    const tridiagonal = Array.from({ length: n }, (_, i) =>
      Array.from({ length: n }, (_, j) => (i === j ? 4 : Math.abs(i - j) === 1 ? -1 : 0)),
    );
    const truth = Float64Array.from({ length: n }, (_, i) => Math.sin(i));
    const rhs = new Float64Array(n);
    dense(tridiagonal)(truth, rhs);
    const nearStart = Float64Array.from(truth, (value) => value + 1e-4);
    const near = conjugateGradient(dense(tridiagonal), rhs, nearStart, { maxIterations: 100, tolerance: 1e-8 });
    const cold = conjugateGradient(dense(tridiagonal), rhs, new Float64Array(n), { maxIterations: 100, tolerance: 1e-8 });
    expect(near.converged && cold.converged).toBe(true);
    expect(near.iterations).toBeLessThan(cold.iterations);
  });

  it('reports non-convergence at the iteration cap and stops on a non positive curvature', () => {
    const capped = conjugateGradient(dense(spd), Float64Array.from([1, 2, 3]), new Float64Array(3), { maxIterations: 1, tolerance: 1e-14 });
    expect(capped.converged).toBe(false);
    expect(capped.iterations).toBe(1);
    expect(capped.relativeResidual).toBeGreaterThan(1e-14);
    const indefinite = [
      [1, 0],
      [0, -1],
    ];
    const broken = conjugateGradient(dense(indefinite), Float64Array.from([0, 1]), new Float64Array(2), {
      maxIterations: 10,
      tolerance: 1e-12,
    });
    expect(broken.converged).toBe(false);
  });
});
