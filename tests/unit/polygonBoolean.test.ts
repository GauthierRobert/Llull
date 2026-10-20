import { describe, expect, it } from 'vitest';
import { polygonArea } from '@lib/polygon';
import type { Vec2 } from '@core/model/vectors';
import { clipToConvex, isConvex, unionPolygons } from '@lib/polygonBoolean';

const rect = (x0: number, y0: number, x1: number, y1: number): [number, number][] => [
  [x0, y0],
  [x1, y0],
  [x1, y1],
  [x0, y1],
];
const total = (rings: readonly (readonly Vec2[])[]): number => rings.reduce((sum, ring) => sum + polygonArea(ring), 0);

describe('unionPolygons', () => {
  it('returns the outer polygon when one contains the other', () => {
    const result = unionPolygons([rect(0, 0, 10, 10), rect(2, 2, 5, 5)]);
    expect(result).toHaveLength(1);
    expect(polygonArea(result[0] ?? [])).toBeCloseTo(100, 9);
    expect(unionPolygons([rect(2, 2, 5, 5), rect(0, 0, 10, 10)]).map(polygonArea)).toEqual([100]);
  });

  it('merges overlapping polygons into an L shape', () => {
    const result = unionPolygons([rect(0, 0, 10, 4), rect(0, 0, 4, 10)]);
    expect(result).toHaveLength(1);
    expect(polygonArea(result[0] ?? [])).toBeCloseTo(40 + 40 - 16, 9);
    expect(result[0]).toHaveLength(6);
  });

  it('merges polygons that share an edge and keeps apart ones separate', () => {
    const joined = unionPolygons([rect(0, 0, 10, 10), rect(10, 0, 20, 10)]);
    expect(joined).toHaveLength(1);
    expect(polygonArea(joined[0] ?? [])).toBeCloseTo(200, 9);
    expect(joined[0]).toHaveLength(4);
    const apart = unionPolygons([rect(0, 0, 1, 1), rect(5, 5, 6, 6)]);
    expect(apart).toHaveLength(2);
    expect(total(apart)).toBeCloseTo(2, 9);
  });

  it('handles identical polygons, clockwise input and degenerate input', () => {
    expect(unionPolygons([rect(0, 0, 3, 3), rect(0, 0, 3, 3)]).map(polygonArea)).toEqual([9]);
    const clockwise = [...rect(0, 0, 3, 3)].reverse();
    expect(unionPolygons([clockwise, rect(1, 1, 5, 5)]).map((ring) => Math.round(polygonArea(ring)))).toEqual([9 + 16 - 4]);
    expect(unionPolygons([])).toEqual([]);
    expect(
      unionPolygons([
        [
          [0, 0],
          [1, 1],
        ],
      ]),
    ).toEqual([]);
    expect(unionPolygons([rect(0, 0, 4, 4), rect(1, 1, 3, 5), rect(5, 0, 6, 1)]).map((ring) => Math.round(polygonArea(ring)))).toEqual([
      18, 1,
    ]);
  });
});

describe('unionPolygons touching cases', () => {
  it('keeps both polygons when they touch only at a corner', () => {
    const result = unionPolygons([rect(0, 0, 1, 1), rect(1, 1, 2, 2)]);
    expect(result).toHaveLength(2);
    expect(total(result)).toBeCloseTo(2, 9);
    expect(unionPolygons([rect(0, 0, 1, 1), rect(1, 1, 2, 2), rect(2, 2, 3, 3)])).toHaveLength(3);
  });

  it('merges a T-junction (a smaller polygon sharing part of an edge) and ignores a single touching point', () => {
    const joined = unionPolygons([rect(0, 0, 10, 10), rect(10, 3, 14, 6)]);
    expect(joined).toHaveLength(1);
    expect(polygonArea(joined[0] ?? [])).toBeCloseTo(100 + 12, 9);
    const point = unionPolygons([
      rect(0, 0, 10, 10),
      [
        [10, 5],
        [14, 3],
        [14, 7],
      ],
    ]);
    expect(point).toHaveLength(2);
    expect(total(point)).toBeCloseTo(108, 9);
  });
});

describe('clipToConvex and isConvex', () => {
  it('clips a polygon by a convex window and reports empty results', () => {
    expect(polygonArea(clipToConvex(rect(-5, -5, 5, 5), rect(0, 0, 10, 10)))).toBeCloseTo(25, 9);
    expect(clipToConvex(rect(20, 20, 30, 30), rect(0, 0, 10, 10))).toEqual([]);
    expect(polygonArea(clipToConvex(rect(1, 1, 2, 2), [...rect(0, 0, 10, 10)].reverse()))).toBeCloseTo(1, 9);
  });

  it('tells convex from concave rings', () => {
    expect(isConvex(rect(0, 0, 1, 1))).toBe(true);
    expect(
      isConvex([
        [0, 0],
        [4, 0],
        [4, 4],
        [2, 1],
        [0, 4],
      ]),
    ).toBe(false);
  });
});
