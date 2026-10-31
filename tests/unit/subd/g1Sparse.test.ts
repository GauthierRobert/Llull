/** 04 DIR §5.8, DES-4c: the limit-surface objective of the conjugate-gradient path (groups above 900 unknowns), checked against the dense orthogonalisation on the same system. */

import { describe, expect, it } from 'vitest';
import { type Sample, type SparseRow, solveDense, solveSparse } from '@core/geometry/subd/g1Linear';
import type { Vec3 } from '@core/model/types';

/** A deterministic pseudo-random sequence in [-1, 1). */
function sequence(seed: number): () => number {
  let state = seed;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return (state / 2 ** 32) * 2 - 1;
  };
}

/** n unknown poles, `rows` sparse conditions (3 terms each, consistent with a hidden solution), `count` samples of 2 terms each aiming at points of a plane. */
function system(n: number, rows: number, count: number, seed = 7): { rows: SparseRow[]; b: Vec3[]; start: Vec3[]; samples: Sample[] } {
  const next = sequence(seed);
  const hidden: Vec3[] = Array.from({ length: n }, () => [next(), next(), next()]);
  const conditions: SparseRow[] = Array.from({ length: rows }, (_, r) => [
    [(3 * r) % n, 1 + 0.1 * next()],
    [(3 * r + 1) % n, -1 + 0.1 * next()],
    [(3 * r + 2) % n, 0.5 + 0.1 * next()],
  ]);
  const b = conditions.map(
    (row): Vec3 =>
      [0, 1, 2].map((axis) => row.reduce((sum, [k, c]) => sum + c * ((hidden[k] as Vec3)[axis] as number), 0)) as unknown as Vec3,
  );
  const start: Vec3[] = hidden.map((p): Vec3 => [p[0] + 0.3 * next(), p[1] + 0.3 * next(), p[2] + 0.3 * next()]);
  const samples: Sample[] = Array.from({ length: count }, (_, k) => ({
    terms: [
      [k % n, 0.6],
      [(5 * k + 1) % n, 0.4],
    ],
    constant: [0, 0, 0],
    target: [0.2 * next(), 0.2 * next(), 0.2 * next()],
  }));
  return { rows: conditions, b, start, samples };
}

const distance = (a: readonly Vec3[], b: readonly Vec3[]): number =>
  Math.max(...a.map((p, k) => Math.hypot(p[0] - (b[k] as Vec3)[0], p[1] - (b[k] as Vec3)[1], p[2] - (b[k] as Vec3)[2])));

describe('solveSparse with a limit-surface objective', () => {
  it('meets the conditions and agrees with the dense solve of the same system (the null-space projection through the sparse rows)', () => {
    const { rows, b, start, samples } = system(60, 12, 90);
    const dense = solveDense(rows, b, start, samples);
    const sparse = solveSparse(rows, b, start, samples);
    expect(dense).toMatchObject({ status: 'ok', objective: 'limit' });
    expect(sparse).toMatchObject({ status: 'ok', objective: 'limit' });
    expect(sparse.residual).toBeLessThan(1e-9);
    expect(distance(sparse.x, dense.x)).toBeLessThan(2e-3);
  });

  it('moves the poles towards the samples inside the solution set: closer to them than the nearest-to-start solution, with the conditions kept', () => {
    const { rows, b, start, samples } = system(60, 12, 90);
    const plain = solveSparse(rows, b, start);
    const limit = solveSparse(rows, b, start, samples);
    expect(plain.objective).toBe('start');
    expect(limit.objective).toBe('limit');
    const misfit = (poles: readonly Vec3[]): number =>
      samples.reduce((sum, sample) => {
        const at = [0, 1, 2].map((axis) => sample.terms.reduce((acc, [k, w]) => acc + w * ((poles[k] as Vec3)[axis] as number), 0));
        return sum + at.reduce((acc, v, axis) => acc + (v - (sample.target[axis] as number)) ** 2, 0);
      }, 0);
    expect(misfit(limit.x)).toBeLessThan(0.5 * misfit(plain.x));
    expect(limit.residual).toBeLessThan(1e-9);
  });

  it('without samples, or with too little work left for a projection, keeps the nearest-to-start solution and says so', () => {
    const { rows, b, start, samples } = system(60, 12, 90);
    expect(solveSparse(rows, b, start, []).objective).toBe('start');
    const nonzeros = rows.reduce((sum, row) => sum + row.length, 0);
    // the feasibility CG needs a few dozen iterations (12 nonzeros each): a budget of 40 of them leaves nothing for the projections
    const tight = solveSparse(rows, b, start, samples, 40 * 12 * nonzeros);
    expect(tight.status === 'ok' ? tight.objective : 'budget').not.toBe('limit');
  });
});
