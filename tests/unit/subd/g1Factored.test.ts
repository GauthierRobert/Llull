/** 04 DIR §5.8, DES-4c: the direct projector (envelope LDL^T of A A^T) behind the limit-surface objective of the big groups: agreement with the dense and iterative paths, dependent rows, scale, budget. */

import { describe, expect, it } from 'vitest';
import { factorRows } from '@core/geometry/subd/g1Factored';
import { type Sample, type SparseRow, solveDense, solveSparse } from '@core/geometry/subd/g1Linear';
import type { Vec3 } from '@core/model/types';

function sequence(seed: number): () => number {
  let state = seed;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return (state / 2 ** 32) * 2 - 1;
  };
}

/** An `side` x `side` grid of poles: a condition per horizontal and vertical neighbour pair (second differences give a structure like the cage rows), samples aiming at a bowl. */
function grid(side: number): { rows: SparseRow[]; b: Vec3[]; start: Vec3[]; samples: Sample[] } {
  const next = sequence(11);
  const n = side * side;
  const at = (i: number, j: number): number => i * side + j;
  const hidden: Vec3[] = Array.from(
    { length: n },
    (_, k): Vec3 => [Math.floor(k / side) + 0.1 * next(), (k % side) + 0.1 * next(), 0.2 * next()],
  );
  const rows: SparseRow[] = [];
  for (let i = 0; i < side - 1; i++)
    for (let j = 0; j < side - 1; j++) {
      rows.push([
        [at(i, j), 1],
        [at(i + 1, j), -2],
        [at(i, j + 1), 1.5],
        [at(i + 1, j + 1), -0.5],
      ]);
    }
  const b = rows.map(
    (row): Vec3 =>
      [0, 1, 2].map((axis) => row.reduce((sum, [k, c]) => sum + c * ((hidden[k] as Vec3)[axis] as number), 0)) as unknown as Vec3,
  );
  const start: Vec3[] = hidden.map((p): Vec3 => [p[0] + 0.3 * next(), p[1] + 0.3 * next(), p[2] + 0.3 * next()]);
  const samples: Sample[] = Array.from({ length: 2 * n }, (_, k) => ({
    terms: [
      [k % n, 0.7],
      [(7 * k + 3) % n, 0.3],
    ],
    constant: [0, 0, 0],
    target: [0.1 * next(), 0.1 * next(), 0.1 * next()],
  }));
  return { rows, b, start, samples };
}

const violationOf = (rows: readonly SparseRow[], b: readonly Vec3[], x: readonly Vec3[]): number =>
  Math.max(
    ...rows.flatMap((row, i) =>
      [0, 1, 2].map((axis) =>
        Math.abs(row.reduce((sum, [k, c]) => sum + c * ((x[k] as Vec3)[axis] as number), 0) - ((b[i] as Vec3)[axis] as number)),
      ),
    ),
  );

const misfit = (samples: readonly Sample[], poles: readonly Vec3[]): number =>
  samples.reduce((sum, sample) => {
    const at = [0, 1, 2].map((axis) => sample.terms.reduce((acc, [k, w]) => acc + w * ((poles[k] as Vec3)[axis] as number), 0));
    return sum + at.reduce((acc, v, axis) => acc + (v - (sample.target[axis] as number)) ** 2, 0);
  }, 0);

const distance = (a: readonly Vec3[], b: readonly Vec3[]): number =>
  Math.max(...a.map((p, k) => Math.hypot(p[0] - (b[k] as Vec3)[0], p[1] - (b[k] as Vec3)[1], p[2] - (b[k] as Vec3)[2])));

describe('the direct projector of the limit-surface objective (factorRows)', () => {
  it('agrees with the dense orthogonalisation and with the iterative projection of the same system (conditions met to 1e-9)', () => {
    const { rows, b, start, samples } = grid(12);
    const dense = solveDense(rows, b, start, samples);
    const direct = solveSparse(rows, b, start, samples);
    const iterative = solveSparse(rows, b, start, samples, undefined, 'iterative');
    expect(direct).toMatchObject({ status: 'ok', objective: 'limit' });
    expect(direct.projectionIterations).toBeUndefined();
    expect(iterative.projectionIterations).toBeGreaterThan(0);
    expect(violationOf(rows, b, direct.x)).toBeLessThan(1e-9);
    expect(distance(direct.x, dense.x)).toBeLessThan(2e-3);
    expect(distance(direct.x, iterative.x)).toBeLessThan(2e-3);
  });

  it('a duplicated and a linearly dependent row are dropped, not divided by: the consistent system is still met and the objective improves', () => {
    const base = grid(8);
    const sum = (p: Vec3, q: Vec3): Vec3 => [p[0] + q[0], p[1] + q[1], p[2] + q[2]];
    const merged = new Map<number, number>();
    for (const [k, c] of [...(base.rows[0] as SparseRow), ...(base.rows[1] as SparseRow)]) merged.set(k, (merged.get(k) ?? 0) + c);
    const rows: SparseRow[] = [...base.rows, base.rows[4] as SparseRow, [...merged], [[3, 0]]];
    const b: Vec3[] = [...base.b, base.b[4] as Vec3, sum(base.b[0] as Vec3, base.b[1] as Vec3), [0, 0, 0]];
    const plain = solveSparse(rows, b, base.start, []);
    const direct = solveSparse(rows, b, base.start, base.samples);
    expect(direct).toMatchObject({ status: 'ok', objective: 'limit' });
    expect(violationOf(rows, b, direct.x)).toBeLessThan(1e-9);
    expect(misfit(base.samples, direct.x)).toBeLessThan(0.7 * misfit(base.samples, plain.x));
  });

  it('is deterministic and bit-stable: two runs of the same system return identical poles', () => {
    const { rows, b, start, samples } = grid(10);
    expect(solveSparse(rows, b, start, samples).x).toEqual(solveSparse(rows, b, start, samples).x);
  });

  it('repeated unknowns inside one row are summed (a row [k, 1] + [k, 1] is the condition 2 x_k)', () => {
    const rows: SparseRow[] = [
      [
        [0, 1],
        [0, 1],
        [1, -1],
      ],
      [
        [1, 1],
        [2, 1],
      ],
    ];
    const b: Vec3[] = [
      [1, 2, 3],
      [0, 0, 0],
    ];
    const samples: Sample[] = [{ terms: [[2, 1]], constant: [0, 0, 0], target: [1, 1, 1] }];
    const solution = solveSparse(rows, b, [[0, 0, 0] as Vec3, [0, 0, 0] as Vec3, [0, 0, 0] as Vec3], samples);
    expect(solution).toMatchObject({ status: 'ok', objective: 'limit' });
    expect(violationOf(rows, b, solution.x)).toBeLessThan(1e-9);
  });

  it('scale: a 5,041 unknown system (71 x 71 grid) is solved with the limit objective, conditions met, misfit below the nearest-to-start poles', () => {
    const { rows, b, start, samples } = grid(71);
    const plain = solveSparse(rows, b, start, []);
    const direct = solveSparse(rows, b, start, samples);
    expect(direct).toMatchObject({ status: 'ok', objective: 'limit' });
    expect(violationOf(rows, b, direct.x)).toBeLessThan(1e-9);
    expect(misfit(samples, direct.x)).toBeLessThan(0.7 * misfit(samples, plain.x));
  }, 120_000);

  it('factorRows: no rows, or a factorisation and its projections over the budget, give no projector (the iterative path stays); within it the projector satisfies A P v = 0', () => {
    const { rows, start } = grid(6);
    expect(factorRows([], 4, 1e12, 31, 3)).toBeNull();
    expect(factorRows(rows, start.length, 10, 31, 3)).toBeNull();
    const projector = factorRows(rows, start.length, 1e12, 31, 3);
    expect(projector).not.toBeNull();
    const v = Float64Array.from({ length: start.length }, (_, k) => Math.sin(k + 1));
    const projected = projector!.project(v);
    for (const row of rows) expect(Math.abs(row.reduce((sum, [k, c]) => sum + c * (projected[k] as number), 0))).toBeLessThan(1e-10);
    expect(projector!.flops).toBeGreaterThan(0);
  });
});
