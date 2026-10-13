import { describe, it, expect } from 'vitest';
import type { Vec3 } from '@core/model/types';
import {
  SEG_CIRCLE,
  SEG_SPHERE_LAT,
  SEG_SPHERE_LON,
  SEG_TORUS_TUBE,
  boxFaces,
  circlePoints,
  earClipTriangulate,
  facetNormal,
  wedgeFaces,
} from '@core/geometry/tessellation';
import { xy } from '../helpers/xy';

describe('tessellation — shared constants', () => {
  it('segmentation constants are positive integers', () => {
    expect(SEG_CIRCLE).toBeGreaterThan(2);
    expect(SEG_SPHERE_LAT).toBeGreaterThan(2);
    expect(SEG_SPHERE_LON).toBeGreaterThan(2);
    expect(SEG_TORUS_TUBE).toBeGreaterThan(2);
  });
});

describe('tessellation — circlePoints', () => {
  it('produces N points on a unit circle at the requested Z plane', () => {
    const pts = circlePoints(0, 0, 5, 1, SEG_CIRCLE);
    expect(pts.length).toBe(SEG_CIRCLE);
    for (const [x, y, z] of pts) {
      expect(Math.hypot(x, y)).toBeCloseTo(1, 9);
      expect(z).toBe(5);
    }
  });
  it('first vertex is at angle 0 (positive-X direction)', () => {
    const pts = circlePoints(0, 0, 0, 3, 8);
    expect(pts[0]![0]).toBeCloseTo(3, 9);
    expect(pts[0]![1]).toBeCloseTo(0, 9);
  });
});

describe('tessellation — earClipTriangulate', () => {
  it('triangulates a CCW triangle to itself', () => {
    const tris = earClipTriangulate(xy(0, 0, 1, 0, 0, 1));
    expect(tris).toEqual([[0, 1, 2]]);
  });
  it('triangulates a convex square into 2 triangles covering 4 vertices', () => {
    const tris = earClipTriangulate(xy(0, 0, 1, 0, 1, 1, 0, 1));
    expect(tris).toHaveLength(2);
    const used = new Set(tris.flat());
    expect(used).toEqual(new Set([0, 1, 2, 3]));
  });
  it('handles a non-convex L-shape (the case fan-triangulation gets wrong)', () => {
    // L-shape: a 2×2 square with the upper-right 1×1 cut out.
    // Vertices CCW: (0,0)(2,0)(2,1)(1,1)(1,2)(0,2)
    const tris = earClipTriangulate(xy(0, 0, 2, 0, 2, 1, 1, 1, 1, 2, 0, 2));
    // 6 vertices → 4 triangles.
    expect(tris).toHaveLength(4);
    for (const [a, b, c] of tris) {
      expect(a).toBeGreaterThanOrEqual(0);
      expect(a).toBeLessThan(6);
      expect(b).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThan(6);
      expect(c).toBeGreaterThanOrEqual(0);
      expect(c).toBeLessThan(6);
    }
  });
  it('Item D — 1400-point non-convex star-like profile produces a plausible mesh', () => {
    // Synthesize a ~1400-point non-convex closed profile (a deeply lobed star,
    // matching the order of magnitude of a 42-tooth gear). Generated inline —
    // NOT imported from gears.ts so this test stays decoupled from the gear math.
    const teeth = 42;
    const samplesPerTooth = 34; // ~1428 total points
    const pts: Array<readonly [number, number]> = [];
    const rOuter = 44;
    const rRoot = 39.5;
    for (let t = 0; t < teeth; t++) {
      for (let s = 0; s < samplesPerTooth; s++) {
        const theta = ((t * samplesPerTooth + s) / (teeth * samplesPerTooth)) * 2 * Math.PI;
        // Alternate between rOuter (tip) and rRoot (root) across each tooth.
        const phase = s / samplesPerTooth;
        const r = phase < 0.5 ? rOuter - (rOuter - rRoot) * (phase * 2) : rRoot + (rOuter - rRoot) * ((phase - 0.5) * 2);
        pts.push([r * Math.cos(theta), r * Math.sin(theta)]);
      }
    }
    expect(pts.length).toBeGreaterThan(1000);
    const tris = earClipTriangulate(pts);
    // For a simple polygon with N vertices, ear-clipping produces EXACTLY N-2
    // triangles. The synthetic profile here is a triangle-wave star — a clean
    // simple polygon — so the strict bound holds. A future regression that
    // silently dropped ears would surface here.
    expect(tris.length).toBe(pts.length - 2);
    // No NaN / undefined indices, all in range.
    for (const [a, b, c] of tris) {
      expect(Number.isInteger(a)).toBe(true);
      expect(Number.isInteger(b)).toBe(true);
      expect(Number.isInteger(c)).toBe(true);
      expect(a).toBeGreaterThanOrEqual(0);
      expect(a).toBeLessThan(pts.length);
      expect(b).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThan(pts.length);
      expect(c).toBeGreaterThanOrEqual(0);
      expect(c).toBeLessThan(pts.length);
    }
  });
  it('returns empty for < 3 points', () => {
    expect(earClipTriangulate([])).toEqual([]);
    expect(earClipTriangulate([[0, 0]])).toEqual([]);
    expect(earClipTriangulate(xy(0, 0, 1, 0))).toEqual([]);
  });
  it('handles CW input by reversing to CCW (winding-tolerant)', () => {
    // CW triangle — should still produce 1 triangle.
    const tris = earClipTriangulate(xy(0, 0, 0, 1, 1, 0));
    expect(tris).toHaveLength(1);
  });
});

describe('tessellation - boxFaces / wedgeFaces', () => {
  const centroid = (points: ReadonlyArray<readonly [number, number, number]>): number[] =>
    [0, 1, 2].map((axis) => points.reduce((sum, p) => sum + (p[axis] ?? 0), 0) / points.length);
  const outward = (faces: Vec3[][], inside: number[]): boolean[] =>
    faces.map((face) => {
      const [a, b, c] = face as [Vec3, Vec3, Vec3];
      const n = facetNormal(a, b, c);
      const mid = centroid(face);
      return n.reduce((sum, value, axis) => sum + value * (mid[axis] ?? 0) - value * (inside[axis] ?? 0), 0) > 0;
    });
  it('box: six quads with outward normals', () => {
    const faces = boxFaces([0, 0, 0], [2, 4, 6]);
    expect(faces).toHaveLength(6);
    expect(outward(faces, [0, 0, 0])).toEqual([true, true, true, true, true, true]);
  });
  it('wedge: five faces with outward normals', () => {
    const faces = wedgeFaces([0, 0, 0], [2, 4, 6]);
    expect(faces).toHaveLength(5);
    expect(outward(faces, [1, 1, 1.5])).toEqual([true, true, true, true, true]);
  });
});
