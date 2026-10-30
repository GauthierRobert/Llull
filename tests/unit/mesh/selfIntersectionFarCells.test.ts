/**
 * The pair search ends whatever the spread of the mesh (DES-7c step 7 slice 4, review round 1): a triangle whose grid cell index is 2^53 or more used to hang the
 * cell loop (`i++` no longer changes the index). Such a face is treated as a large one, and the count does not depend on the broad phase.
 */

import { describe, expect, it } from 'vitest';
import { findSelfIntersections } from '@core/geometry/mesh/selfIntersection';

const tri = (x: number): number[] => [x, 0, 0, x + 1e-6, 0, 0, x, 1e-6, 0];

/** Two triangles of size `s` at `x` that cross like a plus (a corner of each lies in the interior of the other). */
const plus = (x: number, s: number): number[] => [
  x,
  0,
  0,
  x + 2 * s,
  0,
  0,
  x + s,
  0,
  2 * s,
  x + s,
  -s,
  s / 2,
  x + s,
  s,
  s / 2,
  x + s,
  0,
  3 * s,
];

describe('findSelfIntersections with cells far from the origin', () => {
  it('returns for a tiny triangle at 1e11 beside two near the origin', () => {
    const result = findSelfIntersections([...tri(0), ...tri(1), ...tri(1e11)], [0, 1, 2, 3, 4, 5, 6, 7, 8], 5);
    expect(result.count).toBe(0);
  });

  it.each([
    [1e17, 100],
    [1e20, 1e5],
    [1e30, 1e15],
  ])('counts the crossing pair of two triangles at %s among 200 tiny ones at the origin', (far, size) => {
    const tiny = Array.from({ length: 200 }, (_, k) => tri(k * 1e-3)).flat();
    const positions = [...tiny, ...plus(far, size)];
    const faces = positions.length / 9;
    const result = findSelfIntersections(
      positions,
      Array.from({ length: faces * 3 }, (_, i) => i),
      5,
    );
    expect(result).toMatchObject({ count: 1, pairs: [[200, 201]] });
  });
});
