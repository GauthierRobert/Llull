/** 04 DIR §5.8, DES-4c: the direct projector (envelope LDL^T of A A^T) behind the limit-surface objective of the big groups: agreement with the dense and iterative paths, dependent rows, scale, budget. */

import { describe, expect, it } from 'vitest';
import { factorRows } from '@core/geometry/subd/g1Factored';
import { minimumDegree } from '@core/geometry/subd/g1Ordering';
import { factorNumeric, symbolicFill } from '@core/geometry/subd/g1SparseLdl';
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

const ORDERINGS = { ordering: 'rcm' } as const;
const MINIMUM_DEGREE = { ordering: 'minimum-degree' } as const;

describe('feasibility through the factor (DES-4c leftover 1)', () => {
  it('x0 + A^T M^-1 (b - A x0) meets the rows and agrees with the CGLS feasibility step (nearest to the start) on a consistent system, dependent rows included', () => {
    const { rows, b, start } = grid(12);
    const sum = (p: Vec3, q: Vec3): Vec3 => [p[0] + q[0], p[1] + q[1], p[2] + q[2]];
    const dependent: SparseRow[] = [...rows, rows[3] as SparseRow, [...(rows[0] as SparseRow), ...(rows[1] as SparseRow)]];
    const dependentB: Vec3[] = [...b, b[3] as Vec3, sum(b[0] as Vec3, b[1] as Vec3)];
    for (const [system, targets] of [
      [rows, b],
      [dependent, dependentB],
    ] as const) {
      const direct = solveSparse(system, targets, start, []);
      const iterative = solveSparse(system, targets, start, [], undefined, 'iterative');
      expect(direct).toMatchObject({ status: 'ok', objective: 'start' });
      expect(violationOf(system, targets, direct.x)).toBeLessThan(1e-9);
      expect(distance(direct.x, iterative.x)).toBeLessThan(1e-6);
    }
  });

  it('a contradictory duplicate row leaves a residual on both paths (nothing is divided by the dropped row)', () => {
    const { rows, b, start } = grid(8);
    const wrong: Vec3[] = [...b, [(b[2] as Vec3)[0] + 1, (b[2] as Vec3)[1], (b[2] as Vec3)[2]]];
    const system: SparseRow[] = [...rows, rows[2] as SparseRow];
    const direct = solveSparse(system, wrong, start, []);
    const iterative = solveSparse(system, wrong, start, [], undefined, 'iterative');
    expect(direct.residual).toBeGreaterThan(0.1);
    expect(iterative.residual).toBeGreaterThan(0.1);
    expect(Number.isFinite(direct.residual)).toBe(true);
  });

  it('an explicit tight maxWork still refuses: no factor fits, the CGLS feasibility runs out (status budget, start poles kept in the conditions it reached)', () => {
    const { rows, b, start } = grid(12);
    const nonzeros = rows.reduce((sum, row) => sum + row.length, 0);
    expect(solveSparse(rows, b, start, [], 12 * nonzeros)).toMatchObject({ status: 'budget' });
    expect(solveSparse(rows, b, start, [], 12 * nonzeros, 'iterative')).toMatchObject({ status: 'budget' });
  });
});

describe('minimum degree ordering and the sparse LDL^T (DES-4c leftover 2)', () => {
  it('minimumDegree is a permutation, deterministic, and eliminates the leaves of a star before its hub (the hub is among the last two)', () => {
    const star: number[][] = [[1, 2, 3, 4], [0], [0], [0], [0]];
    const order = minimumDegree(star);
    expect([...order].sort()).toEqual([0, 1, 2, 3, 4]);
    expect(order.indexOf(0)).toBeGreaterThanOrEqual(3);
    expect(minimumDegree(star)).toEqual(order);
    const { rows } = grid(9);
    const adjacent = (side: number): number[][] =>
      Array.from({ length: side * side }, (_, k) =>
        [k - side, k + side, k % side ? k - 1 : -1, (k + 1) % side ? k + 1 : -1]
          .filter((v) => v >= 0 && v < side * side)
          .sort((p, q) => p - q),
      );
    const lattice = minimumDegree(adjacent(12));
    expect(new Set(lattice).size).toBe(144);
    expect(rows.length).toBeGreaterThan(0);
  });

  it('symbolicFill + factorNumeric solve a small SPD system (an arrow matrix) exactly and drop a dependent row', () => {
    // M = [[4,1,1],[1,3,0],[1,0,2]] (upper pattern: column 1 has row 0, column 2 has row 0)
    const symbolic = symbolicFill([[], [0], [0]]);
    expect(symbolic.fill).toBe(3);
    const columns: Array<[number[], number[]]> = [
      [[0], [4]],
      [
        [0, 1],
        [1, 3],
      ],
      [
        [0, 2],
        [1, 2],
      ],
    ];
    const solve = factorNumeric(
      symbolic,
      (k) => columns[k] as [number[], number[]],
      () => false,
    );
    const z = solve(Float64Array.from([6, 4, 3]));
    const back = [4 * z[0]! + z[1]! + z[2]!, z[0]! + 3 * z[1]!, z[0]! + 2 * z[2]!];
    expect(back[0]).toBeCloseTo(6, 12);
    expect(back[1]).toBeCloseTo(4, 12);
    expect(back[2]).toBeCloseTo(3, 12);
    // the last row a copy of the first: its pivot cancels and it is dropped (0 in the answer)
    const copy = factorNumeric(
      symbolicFill([[], [0]]),
      (k) =>
        k === 0
          ? [[0], [1]]
          : [
              [0, 1],
              [1, 1],
            ],
      (pivot) => !(pivot > 1e-12),
    );
    expect(copy(Float64Array.from([2, 2]))[1]).toBe(0);
  });

  it('minimum degree agrees with the envelope, the iterative path and the dense path (grid 12), with and without dependent rows', () => {
    const { rows, b, start, samples } = grid(12);
    const dense = solveDense(rows, b, start, samples);
    const envelope = solveSparse(rows, b, start, samples, undefined, 'direct', ORDERINGS);
    const sparse = solveSparse(rows, b, start, samples, undefined, 'direct', MINIMUM_DEGREE);
    const iterative = solveSparse(rows, b, start, samples, undefined, 'iterative');
    expect(sparse).toMatchObject({ status: 'ok', objective: 'limit' });
    expect(violationOf(rows, b, sparse.x)).toBeLessThan(1e-9);
    expect(distance(sparse.x, envelope.x)).toBeLessThan(1e-6);
    expect(distance(sparse.x, dense.x)).toBeLessThan(2e-3);
    expect(distance(sparse.x, iterative.x)).toBeLessThan(2e-3);
    const base = grid(8);
    const system: SparseRow[] = [...base.rows, base.rows[4] as SparseRow, [[3, 0]]];
    const targets: Vec3[] = [...base.b, base.b[4] as Vec3, [0, 0, 0]];
    const dropped = solveSparse(system, targets, base.start, base.samples, undefined, 'direct', MINIMUM_DEGREE);
    const reference = solveSparse(system, targets, base.start, base.samples, undefined, 'direct', ORDERINGS);
    expect(dropped).toMatchObject({ status: 'ok', objective: 'limit' });
    expect(distance(dropped.x, reference.x)).toBeLessThan(1e-6);
  });

  it('is bit-identical twice (ordering, factor, solve)', () => {
    const { rows, b, start, samples } = grid(10);
    const first = solveSparse(rows, b, start, samples, undefined, 'direct', MINIMUM_DEGREE);
    expect(solveSparse(rows, b, start, samples, undefined, 'direct', MINIMUM_DEGREE)).toEqual(first);
  });

  it('a system whose envelope is over its limit now factors (auto picks minimum degree); with both limits too small, or one ordering forced over its limit, the iterative path is kept', () => {
    const { rows, b, start, samples } = grid(14);
    const n = start.length;
    expect(factorRows(rows, n, 1e12, 31, 6, { ...ORDERINGS, envelopeLimit: 100 })).toBeNull();
    const auto = factorRows(rows, n, 1e12, 31, 6, { envelopeLimit: 100 });
    expect(auto).not.toBeNull();
    const v = Float64Array.from({ length: n }, (_, k) => Math.cos(k + 2));
    const projected = auto!.project(v);
    for (const row of rows) expect(Math.abs(row.reduce((sum, [k, c]) => sum + c * (projected[k] as number), 0))).toBeLessThan(1e-10);
    const limits = { envelopeLimit: 100, fillLimit: 100 };
    expect(factorRows(rows, n, 1e12, 31, 6, limits)).toBeNull();
    expect(factorRows(rows, n, 1e12, 31, 6, { ...MINIMUM_DEGREE, fillLimit: 100 })).toBeNull();
    expect(factorRows(rows, n, 10, 31, 6, MINIMUM_DEGREE)).toBeNull();
    const fallback = solveSparse(rows, b, start, samples, undefined, 'direct', limits);
    expect(fallback.projectionIterations).toBeGreaterThan(0);
    const factored = solveSparse(rows, b, start, samples, undefined, 'direct', { envelopeLimit: 100 });
    expect(factored.projectionIterations).toBeUndefined();
    expect(factored).toMatchObject({ status: 'ok', objective: 'limit' });
    expect(distance(factored.x, fallback.x)).toBeLessThan(2e-3);
  });

  it('a tight explicit maxWork refuses a minimum-degree factor like an envelope one (status budget on the iterative path)', () => {
    const { rows, b, start, samples } = grid(12);
    const nonzeros = rows.reduce((sum, row) => sum + row.length, 0);
    expect(solveSparse(rows, b, start, samples, 12 * nonzeros, 'direct', MINIMUM_DEGREE)).toMatchObject({ status: 'budget' });
  });
});
