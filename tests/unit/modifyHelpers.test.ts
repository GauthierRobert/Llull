/**
 * Unit tests for the pure geometry helpers in src/ui/viewport/2d/modifyHelpers.ts.
 *
 * These are pure functions with no React/three.js dependencies — fast and exhaustive.
 */

import { describe, it, expect } from 'vitest';
import {
  nearestVertex,
  offsetSideSign,
  dist2,
  pointToSegDistSq,
  entityDistSq,
} from '../../src/ui/viewport/2d/modifyHelpers';
import type { Vec2 } from '../../src/core/model/types';
import type { LineEntity, PolylineEntity, CircleEntity, RectangleEntity } from '../../src/core/model/types';

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

// ---------------------------------------------------------------------------
// pointToSegDistSq
// ---------------------------------------------------------------------------

describe('pointToSegDistSq', () => {
  it('returns 0 when the point is exactly on the segment', () => {
    expect(pointToSegDistSq([5, 0], [0, 0], [10, 0])).toBeCloseTo(0);
  });

  it('returns squared distance to the nearest endpoint when point projects outside segment', () => {
    // Point at (15, 0), segment from (0,0) to (10,0) — nearest endpoint is (10,0)
    expect(pointToSegDistSq([15, 0], [0, 0], [10, 0])).toBeCloseTo(25);
  });

  it('returns squared perpendicular distance for a point beside the segment midpoint', () => {
    // Point at (5, 3), segment from (0,0) to (10,0) — perp dist = 3, distSq = 9
    expect(pointToSegDistSq([5, 3], [0, 0], [10, 0])).toBeCloseTo(9);
  });

  it('handles a degenerate segment (zero length) as a point', () => {
    // Zero-length segment: both endpoints at (3,4). Distance to (0,0) = 5, distSq = 25
    expect(pointToSegDistSq([0, 0], [3, 4], [3, 4])).toBeCloseTo(25);
  });
});

// ---------------------------------------------------------------------------
// entityDistSq — position-aware pick distance
// ---------------------------------------------------------------------------

/** Minimal base entity fields shared by all test fixtures. */
const BASE = {
  id: 'e1',
  rotation: [0, 0, 0] as const,
  layerId: 'layer-default',
  color: '#ffffff',
};

describe('entityDistSq — line at origin', () => {
  it('picks a line whose start/end are at the origin', () => {
    const line: LineEntity = {
      ...BASE,
      kind: 'line',
      position: [0, 0, 0],
      start: [0, 0],
      end: [10, 0],
    };
    // Pick directly on the segment
    expect(entityDistSq(line, [5, 0])).toBeCloseTo(0);
    // Pick beside the midpoint
    expect(entityDistSq(line, [5, 3])).toBeCloseTo(9);
  });
});

describe('entityDistSq — line with non-zero position', () => {
  it('correctly handles a line offset by entity.position', () => {
    // Line segment [0,0]→[10,0] in local space, but entity is at world (20, 5).
    // World coords: start=(20,5), end=(30,5).
    const line: LineEntity = {
      ...BASE,
      kind: 'line',
      position: [20, 5, 0],
      start: [0, 0],
      end: [10, 0],
    };
    // World pick at the midpoint in world space → exactly on segment → distSq ≈ 0
    expect(entityDistSq(line, [25, 5])).toBeCloseTo(0);
    // World pick 3 units above the segment in world space → distSq ≈ 9
    expect(entityDistSq(line, [25, 8])).toBeCloseTo(9);
    // Without the position fix, a pick at (25, 5) would be shifted to local (5, 5)
    // and compare against [0,0]→[10,0], giving distSq=25 instead of 0 — verify this.
    const naiveDist = pointToSegDistSq([25, 5], [0, 0], [10, 0]);
    expect(naiveDist).not.toBeCloseTo(0); // naive (broken) approach gives wrong answer
  });

  it('returns near-zero for a pick at a non-zero-position line endpoint', () => {
    const line: LineEntity = {
      ...BASE,
      kind: 'line',
      position: [100, 200, 0],
      start: [0, 0],
      end: [50, 0],
    };
    // World endpoint = (150, 200)
    expect(entityDistSq(line, [150, 200])).toBeCloseTo(0);
  });
});

describe('entityDistSq — polyline with non-zero position', () => {
  it('picks a polyline translated by position', () => {
    const poly: PolylineEntity = {
      ...BASE,
      kind: 'polyline',
      position: [10, 10, 0],
      points: [
        [0, 0],
        [5, 0],
        [5, 5],
      ],
      closed: false,
    };
    // World pick at (10, 10) = local (0,0) = first vertex → distSq ≈ 0
    expect(entityDistSq(poly, [10, 10])).toBeCloseTo(0);
  });
});

describe('entityDistSq — circle with non-zero position', () => {
  it('picks a circle whose center is translated by position', () => {
    const circle: CircleEntity = {
      ...BASE,
      kind: 'circle',
      position: [5, 5, 0],
      center: [0, 0],
      radius: 3,
    };
    // World pick at (5+3, 5) = exactly on the circumference → distSq ≈ 0
    expect(entityDistSq(circle, [8, 5])).toBeCloseTo(0);
  });
});

describe('entityDistSq — rectangle with non-zero position', () => {
  it('picks a rectangle whose local origin is offset by position', () => {
    const rect: RectangleEntity = {
      ...BASE,
      kind: 'rectangle',
      position: [10, 10, 0],
      width: 6,
      height: 4,
    };
    // World pick at (10, 10) = local (0,0) = bottom-left corner → distSq ≈ 0
    expect(entityDistSq(rect, [10, 10])).toBeCloseTo(0);
  });

  it('returns Infinity for unsupported entity kinds', () => {
    const box = { ...BASE, kind: 'box' as const, position: [0, 0, 0] as const, size: [1, 1, 1] as const };
    expect(entityDistSq(box as never, [0, 0])).toBe(Infinity);
  });
});
