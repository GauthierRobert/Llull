import { describe, expect, it } from 'vitest';
import type { Vec2, Vec3 } from '@core/model/types';
import { delaunay } from '@aec/civil/delaunay';
import {
  buildTin,
  contourLevels,
  elevationAt,
  slopeAt,
  tinBounds,
  tinMesh,
  tinPlanArea,
  traceContour,
  triangleCount,
} from '@aec/civil/tin';

function random(seed: number): () => number {
  let state = seed;
  return () => (state = (state * 16807) % 2147483647) / 2147483647;
}

function circumcircleContains(points: Vec2[], tri: number[], p: Vec2): boolean {
  const [a, b, c] = tri.map((index) => points[index] as Vec2) as [Vec2, Vec2, Vec2];
  const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
  const ux =
    ((a[0] ** 2 + a[1] ** 2) * (b[1] - c[1]) +
      (b[0] ** 2 + b[1] ** 2) * (c[1] - a[1]) +
      (c[0] ** 2 + c[1] ** 2) * (a[1] - b[1])) /
    d;
  const uy =
    ((a[0] ** 2 + a[1] ** 2) * (c[0] - b[0]) +
      (b[0] ** 2 + b[1] ** 2) * (a[0] - c[0]) +
      (c[0] ** 2 + c[1] ** 2) * (b[0] - a[0])) /
    d;
  const r = Math.hypot(a[0] - ux, a[1] - uy);
  return Math.hypot(p[0] - ux, p[1] - uy) < r * (1 - 1e-9);
}

describe('delaunay', () => {
  it('returns no triangle for fewer than 3 points', () => {
    expect(delaunay([])).toEqual([]);
    expect(
      delaunay([
        [0, 0],
        [1, 1],
      ]),
    ).toEqual([]);
  });

  it('triangulates a square grid with 2(n-1)² triangles', () => {
    const points: Vec2[] = [];
    for (let i = 0; i < 12; i++) for (let j = 0; j < 12; j++) points.push([i * 3, j * 3]);
    expect(delaunay(points).length / 3).toBe(2 * 11 * 11);
  });

  it('produces counter-clockwise triangles with empty circumcircles', () => {
    const next = random(7);
    const points: Vec2[] = Array.from({ length: 300 }, () => [
      650000 + next() * 500,
      6800000 + next() * 500,
    ]);
    const triangles = delaunay(points);
    // Euler: 2n - 2 - h triangles, h hull vertices (>= 3).
    expect(triangles.length / 3).toBeLessThanOrEqual(2 * 300 - 5);
    expect(triangles.length / 3).toBeGreaterThan(2 * 300 - 60);
    for (let k = 0; k < triangles.length; k += 3) {
      const tri = triangles.slice(k, k + 3);
      const [a, b, c] = tri.map((index) => points[index] as Vec2) as [Vec2, Vec2, Vec2];
      expect((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])).toBeGreaterThan(0);
      for (let p = 0; p < points.length; p += 7) {
        if (tri.includes(p)) continue;
        expect(circumcircleContains(points, tri, points[p] as Vec2)).toBe(false);
      }
    }
  });

  it('gives nothing for collinear points', () => {
    expect(
      delaunay([
        [0, 0],
        [1, 0],
        [2, 0],
        [3, 0],
      ]),
    ).toEqual([]);
  });
});

const plane = (x: number, y: number): number => 10 + 0.1 * x - 0.05 * y;

function planeTin(): ReturnType<typeof buildTin> {
  const points: Vec3[] = [];
  for (let i = 0; i <= 10; i++) for (let j = 0; j <= 10; j++) points.push([i, j, plane(i, j)]);
  return buildTin(points);
}

describe('tin', () => {
  it('interpolates a plane exactly and is null outside', () => {
    const tin = planeTin();
    expect(elevationAt(tin, [3.3, 7.1])).toBeCloseTo(plane(3.3, 7.1), 9);
    expect(elevationAt(tin, [0, 0])).toBeCloseTo(10, 9);
    expect(elevationAt(tin, [11, 5])).toBeNull();
    expect(elevationAt(tin, [-1, -1])).toBeNull();
    expect(slopeAt(tin, [5, 5])).toBeCloseTo(Math.hypot(0.1, 0.05), 6);
    expect(slopeAt(tin, [20, 5])).toBeNull();
    expect(tinPlanArea(tin)).toBeCloseTo(100, 9);
    expect(triangleCount(tin)).toBe(200);
  });

  it('merges duplicate plan points and filters by boundary and edge length', () => {
    const tin = buildTin([
      [0, 0, 1],
      [0, 0, 5],
      [10, 0, 1],
      [0, 10, 1],
      [10, 10, 1],
      [100, 100, 1],
    ]);
    expect(tin.points).toHaveLength(5);
    const short = buildTin(tin.points, { maxEdgeLength: 20 });
    expect(triangleCount(short)).toBe(2);
    const clipped = buildTin(tin.points, {
      boundary: [
        [-1, -1],
        [11, -1],
        [11, 11],
        [-1, 11],
      ],
    });
    expect(triangleCount(clipped)).toBe(2);
  });

  it('reports bounds, levels and a compact mesh', () => {
    const tin = planeTin();
    const bounds = tinBounds(tin);
    expect(bounds?.min[2]).toBeCloseTo(9.5, 9);
    expect(bounds?.max[2]).toBeCloseTo(11, 9);
    expect(contourLevels(tin, 0.5)).toEqual([9.5, 10, 10.5, 11]);
    expect(contourLevels(tin, 0)).toEqual([]);
    expect(contourLevels(tin, 0.001, 3)).toHaveLength(3);
    expect(tinBounds(buildTin([]))).toBeNull();
    expect(contourLevels(buildTin([]), 1)).toEqual([]);
    const mesh = tinMesh(tin);
    expect(mesh.positions).toHaveLength(121 * 3);
    expect(mesh.indices).toHaveLength(600);
  });

  it('traces straight contours across a plane and closed loops around a hill', () => {
    const lines = traceContour(planeTin(), 10.25);
    expect(lines).toHaveLength(1);
    for (const [x, y] of lines[0] as Vec2[]) expect(plane(x, y)).toBeCloseTo(10.25, 6);
    const hill: Vec3[] = [];
    for (let i = -5; i <= 5; i++) {
      for (let j = -5; j <= 5; j++) hill.push([i, j, 10 - Math.hypot(i, j)]);
    }
    const loops = traceContour(buildTin(hill), 7.5);
    expect(loops).toHaveLength(1);
    const loop = loops[0] as Vec2[];
    expect(loop[0]).toEqual(loop[loop.length - 1]);
    // A vertex exactly on the level does not split the contour.
    expect(traceContour(planeTin(), 10)).toHaveLength(1);
  });
});
