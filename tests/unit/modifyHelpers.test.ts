/**
 * Unit tests for the pure geometry helpers in src/ui/viewport/2d/modifyHelpers.ts.
 *
 * These are pure functions with no React/three.js dependencies — fast and exhaustive.
 */

import { describe, it, expect } from 'vitest';
import { nearestVertex, offsetSideSign, dist2 } from '../../src/ui/viewport/2d/modifyHelpers';
import type { Vec2 } from '../../src/core/model/types';

// ---------------------------------------------------------------------------
// nearestVertex
// ---------------------------------------------------------------------------

describe('nearestVertex', () => {
  it('returns null for an empty points array', () => {
    expect(nearestVertex([], [0, 0])).toBeNull();
  });

  it('returns the only point when there is one vertex', () => {
    const result = nearestVertex([[3, 4]], [0, 0]);
    expect(result).not.toBeNull();
    expect(result!.vertexIndex).toBe(0);
    expect(result!.point).toEqual([3, 4]);
  });

  it('picks the nearest vertex from multiple candidates', () => {
    const points: Vec2[] = [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
    ];
    const result = nearestVertex(points, [9, 1]);
    // [10, 0] is nearest to [9, 1]
    expect(result!.vertexIndex).toBe(1);
    expect(result!.point).toEqual([10, 0]);
  });

  it('picks the first vertex when equidistant', () => {
    const points: Vec2[] = [
      [0, 0],
      [2, 0],
    ];
    // Pick exactly at [1, 0] — equidistant; the first encountered wins
    const result = nearestVertex(points, [1, 0]);
    expect(result!.vertexIndex).toBe(0);
  });

  it('returns distSq 0 when the pick is exactly on a vertex', () => {
    const points: Vec2[] = [[5, 7], [2, 3]];
    const result = nearestVertex(points, [5, 7]);
    expect(result!.vertexIndex).toBe(0);
    expect(result!.distSq).toBe(0);
  });

  it('returns correct distSq', () => {
    const points: Vec2[] = [[0, 0], [3, 4]];
    const result = nearestVertex(points, [0, 0]);
    // Nearest is [0,0], distSq = 0
    expect(result!.distSq).toBe(0);
  });

  it('works with negative coordinates', () => {
    const points: Vec2[] = [[-5, -5], [5, 5]];
    const result = nearestVertex(points, [-4, -4]);
    expect(result!.vertexIndex).toBe(0);
  });

  it('handles a single-point polyline correctly', () => {
    const result = nearestVertex([[100, 200]], [0, 0]);
    expect(result!.vertexIndex).toBe(0);
    expect(result!.point).toEqual([100, 200]);
    expect(result!.distSq).toBeCloseTo(100 * 100 + 200 * 200);
  });
});

// ---------------------------------------------------------------------------
// offsetSideSign
// ---------------------------------------------------------------------------

describe('offsetSideSign', () => {
  it('returns +1 when pick is to the left of start→end (upward direction)', () => {
    // Line from (0,0) to (10,0) — left of travel is top (positive Y)
    const sign = offsetSideSign([0, 0], [10, 0], [5, 3]);
    expect(sign).toBe(1);
  });

  it('returns -1 when pick is to the right of start→end (upward direction)', () => {
    const sign = offsetSideSign([0, 0], [10, 0], [5, -3]);
    expect(sign).toBe(-1);
  });

  it('returns +1 when cross product is zero (pick on the line)', () => {
    const sign = offsetSideSign([0, 0], [10, 0], [5, 0]);
    expect(sign).toBe(1);
  });

  it('works for a vertical line (left = negative X)', () => {
    // Line from (0,0) to (0,10), left of travel = negative X
    const sign = offsetSideSign([0, 0], [0, 10], [-2, 5]);
    expect(sign).toBe(1);
  });

  it('works for a diagonal line', () => {
    // Line from (0,0) to (1,1) — left of travel is upper-left
    const signLeft = offsetSideSign([0, 0], [1, 1], [-1, 1]);
    const signRight = offsetSideSign([0, 0], [1, 1], [1, -1]);
    expect(signLeft).toBe(1);
    expect(signRight).toBe(-1);
  });
});

// ---------------------------------------------------------------------------
// dist2
// ---------------------------------------------------------------------------

describe('dist2', () => {
  it('returns 0 for identical points', () => {
    expect(dist2([3, 4], [3, 4])).toBe(0);
  });

  it('computes a 3-4-5 right triangle hypotenuse', () => {
    expect(dist2([0, 0], [3, 4])).toBeCloseTo(5);
  });

  it('works with negative coordinates', () => {
    expect(dist2([-3, 0], [0, 4])).toBeCloseTo(5);
  });

  it('is commutative', () => {
    const a: Vec2 = [1, 2];
    const b: Vec2 = [4, 6];
    expect(dist2(a, b)).toBeCloseTo(dist2(b, a));
  });

  it('returns positive for non-identical points', () => {
    expect(dist2([0, 0], [0.001, 0])).toBeGreaterThan(0);
  });
});
