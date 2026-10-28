/**
 * The pair search keeps no table of the pairs it has seen (a Set of pairs throws a RangeError past 2^24 entries, as the 1.3M-triangle sphere did): a pair is
 * a candidate once, in the lowest grid cell its two cell ranges share. Same count and same pairs as testing every pair, and never more candidates than pairs.
 */

import { describe, expect, it } from 'vitest';
import { segmentHitsTriangle } from '@lib/segmentTriangle';
import { icosphereMesh } from '@core/geometry/mesh/primitives';
import { findSelfIntersections } from '@core/geometry/mesh/selfIntersection';
import type { Vec3 } from '@core/model/vectors';

function stream(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
}

/** Triangles with their own vertices: `small` of size ~1 in a 6-cube (many share cells), plus `big` ones that span many cells. */
function soup(seed: number, small: number, big: number): { positions: number[]; indices: number[] } {
  const next = stream(seed);
  const positions: number[] = [];
  const triangle = (size: number): void => {
    const origin = [next() * 6, next() * 6, next() * 6];
    for (let k = 0; k < 3; k++) positions.push(...origin.map((v) => v + (next() - 0.5) * size));
  };
  for (let t = 0; t < small; t++) triangle(1.5);
  for (let t = 0; t < big; t++) triangle(14);
  return { positions, indices: Array.from({ length: positions.length / 3 }, (_, i) => i) };
}

/** Every pair, the definition: no shared vertex, boxes overlap, an edge of one passes through the other. */
function bruteForce(positions: number[], indices: number[]): Array<[number, number]> {
  const faces = indices.length / 3;
  const corners = (f: number): [Vec3, Vec3, Vec3] =>
    [0, 1, 2].map(
      (k) => positions.slice((indices[f * 3 + k] as number) * 3, (indices[f * 3 + k] as number) * 3 + 3) as unknown as Vec3,
    ) as [Vec3, Vec3, Vec3];
  const crosses = (a: [Vec3, Vec3, Vec3], b: [Vec3, Vec3, Vec3]): boolean =>
    [0, 1, 2].some(
      (k) => segmentHitsTriangle(a[k] as Vec3, a[(k + 1) % 3] as Vec3, b) || segmentHitsTriangle(b[k] as Vec3, b[(k + 1) % 3] as Vec3, a),
    );
  const out: Array<[number, number]> = [];
  for (let x = 0; x < faces; x++) {
    for (let y = x + 1; y < faces; y++) {
      const shared = [0, 1, 2].some((i) => [0, 1, 2].some((j) => indices[x * 3 + i] === indices[y * 3 + j]));
      const [a, b] = [corners(x), corners(y)];
      const overlap = [0, 1, 2].every(
        (axis) =>
          Math.min(...a.map((p) => p[axis] as number)) <= Math.max(...b.map((p) => p[axis] as number)) &&
          Math.min(...b.map((p) => p[axis] as number)) <= Math.max(...a.map((p) => p[axis] as number)),
      );
      if (!shared && overlap && crosses(a, b)) out.push([x, y]);
    }
  }
  return out;
}

/** The soup of `seed` with the triangles from `from` on moved by `shift` along x (a second cluster far from the first). */
function shifted(seed: number, small: number, big: number, from: number, shift: number): { positions: number[]; indices: number[] } {
  const base = soup(seed, small, big);
  return { positions: base.positions.map((v, i) => (i >= from * 9 && i % 3 === 0 ? v + shift : v)), indices: base.indices };
}

describe('self-intersection pairs without a table of seen pairs', () => {
  it.each([
    [1, 60, 0],
    [2, 80, 3],
    [3, 20, 8],
    [4, 120, 1],
  ])('seed %i (%i small, %i large triangles): the pairs and their count are those of testing every pair', (seed, small, big) => {
    const { positions, indices } = soup(seed, small, big);
    const expected = bruteForce(positions, indices);
    const found = findSelfIntersections(positions, indices, 100_000);
    expect(expected.length).toBeGreaterThan(0);
    expect(found.count).toBe(expected.length);
    expect(found.pairs.map((pair) => [...pair])).toEqual(expected);
  });

  it.each([
    ['everything at x = 1e10 (cell indices past 2^31)', shifted(2, 80, 3, 0, 1e10)],
    ['two clusters 1e10 apart', shifted(6, 70, 2, 40, 1e10)],
    ['two clusters 3e9 apart', shifted(7, 70, 2, 40, 3e9)],
  ])('%s: the pairs and their count are those of testing every pair', (_name, { positions, indices }) => {
    const expected = bruteForce(positions, indices);
    const found = findSelfIntersections(positions, indices, 100_000);
    expect(expected.length).toBeGreaterThan(0);
    expect(found.count).toBe(expected.length);
    expect(found.pairs.map((pair) => [...pair])).toEqual(expected);
  });

  it.each([1e6, 1e10, 3e11])('two crossing triangles at x = %s with a small triangle at the origin: the pair is found', (far) => {
    // cell indices of the far pair pass 2^31 (an Int32Array of them wraps and the pair is never tested)
    const positions = [
      ...[far - 1, 0, -1, far + 1, 0, -1, far, 0, 1],
      ...[far - 0.2, -1, 0, far + 0.2, 1, 0, far, 0.5, 0.6],
      ...[0, 0, 0, 1, 0, 0, 0, 1, 0],
    ];
    const found = findSelfIntersections(positions, [0, 1, 2, 3, 4, 5, 6, 7, 8], 10);
    expect(found.count).toBe(1);
    expect(found.pairs.map((pair) => [...pair])).toEqual([[0, 1]]);
  });

  it('a pair is a candidate once however many cells its triangles share, large triangles included', () => {
    const { positions, indices } = soup(5, 70, 4);
    const faces = indices.length / 3;
    const found = findSelfIntersections(positions, indices, 0);
    expect(found.candidates).toBeGreaterThan(0);
    // with a table-free rule that tested a pair in every shared cell this is several times the number of pairs
    expect(found.candidates).toBeLessThanOrEqual((faces * (faces - 1)) / 2);
  });

  it('the 1,310,720-triangle noisy sphere (20 million candidate pairs, past the 2^24 entries of a Set) is searched without a RangeError', () => {
    const sphere = icosphereMesh(10, 8, [0, 0, 0]);
    const next = stream(42);
    const positions = sphere.positions.map((v) => v + (next() * 2 - 1) * 0.02);
    const found = findSelfIntersections(positions, sphere.indices, 20);
    expect(found.candidates).toBeGreaterThan(2 ** 24);
    expect(found.count).toBeGreaterThan(0);
  }, 120_000);
});
