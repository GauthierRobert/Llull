/** PHY-16 3-2-1 support: which dofs are fixed, that they are always six independent rigid-body constraints, and when the three points are refused. */
import { describe, expect, it } from 'vitest';
import type { Vec3 } from '@core/model/vectors';
import { support321 } from '@cae/process/support321';

/** Rank of the rigid-body rows (translation + moment of each fixed dof) by Gaussian elimination: an oracle independent of the implementation. */
function rigidBodyRank(points: readonly [Vec3, Vec3, Vec3], dofs: readonly (readonly number[])[]): number {
  const rows = dofs.flatMap((list, index) =>
    list.map((dof) => {
      const [x, y, z] = points[index] ?? [0, 0, 0];
      const e: Vec3 = [dof === 1 ? 1 : 0, dof === 2 ? 1 : 0, dof === 3 ? 1 : 0];
      return [...e, y * e[2] - z * e[1], z * e[0] - x * e[2], x * e[1] - y * e[0]];
    }),
  );
  let rank = 0;
  for (let column = 0; column < 6; column++) {
    const pivot = rows.findIndex((row, i) => i >= rank && Math.abs(row[column] ?? 0) > 1e-9);
    if (pivot < 0) continue;
    const lead = rows[pivot] ?? [];
    rows[pivot] = rows[rank] ?? [];
    rows[rank] = lead;
    for (let i = rank + 1; i < rows.length; i++) {
      const factor = (rows[i]?.[column] ?? 0) / (lead[column] ?? 1);
      rows[i] = (rows[i] ?? []).map((value, c) => value - factor * (lead[c] ?? 0));
    }
    rank += 1;
  }
  return rank;
}

describe('support321', () => {
  it('fixes P1 in x y z, P2 in the two axes orthogonal to P1P2 and P3 in the axis the rotation about P1P2 moves most', () => {
    expect(
      support321([
        [2, 0, 0],
        [2, 1, 0],
        [0, 0, 0],
      ]),
    ).toEqual([[1, 2, 3], [1, 3], [3]]);
    expect(
      support321([
        [0, 0, 0],
        [1, 0, 0],
        [0, 1, 0],
      ]),
    ).toEqual([[1, 2, 3], [2, 3], [3]]);
    expect(
      support321([
        [0, 0, 0],
        [0, 0, 1],
        [1, 0, 0],
      ]),
    ).toEqual([[1, 2, 3], [1, 2], [2]]);
  });

  it('always leaves six independent rigid-body constraints (200 deterministic pseudo-random non-collinear triples, tilted and axis aligned)', () => {
    let seed = 12345;
    const next = (): number => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296 - 0.5;
    };
    let checked = 0;
    for (let i = 0; i < 200; i++) {
      const points: [Vec3, Vec3, Vec3] = [
        [next() * 10, next() * 10, next() * 10],
        i % 4 === 0 ? [5, 0, 0] : [next() * 10, next() * 10, next() * 10],
        [next() * 10, next() * 10, next() * 10],
      ];
      const dofs = support321(points);
      if (typeof dofs === 'string') continue;
      checked += 1;
      expect(dofs.flat()).toHaveLength(6);
      expect(rigidBodyRank(points, dofs), JSON.stringify(points)).toBe(6);
    }
    expect(checked).toBe(200);
  });

  it('refuses coincident, collinear and non-finite points by name of the reason', () => {
    expect(
      support321([
        [0, 0, 0],
        [0, 0, 0],
        [1, 1, 1],
      ]),
    ).toContain('coincide');
    expect(
      support321([
        [0, 0, 0],
        [1, 1, 1],
        [2, 2, 2],
      ]),
    ).toContain('collinear');
    expect(
      support321([
        [0, 0, 0],
        [1, 0, 0],
        [Number.NaN, 1, 0],
      ]),
    ).toContain('finite');
  });
});
