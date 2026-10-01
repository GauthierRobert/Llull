import { describe, expect, it } from 'vitest';
import { triangulatePolygon } from '@lib/triangulate';
import { polygonArea, type Point2 } from '@lib/polygon';

function triangulatedArea(outer: Point2[], holes: Point2[][] = []): number {
  const { vertices, triangles } = triangulatePolygon(outer, holes);
  return triangles.reduce((sum, [a, b, c]) => {
    const [pa, pb, pc] = [vertices[a]!, vertices[b]!, vertices[c]!];
    const signed = ((pb[0] - pa[0]) * (pc[1] - pa[1]) - (pb[1] - pa[1]) * (pc[0] - pa[0])) / 2;
    expect(signed).toBeGreaterThan(0);
    return sum + signed;
  }, 0);
}

const rect = (x0: number, y0: number, x1: number, y1: number): Point2[] => [
  [x0, y0],
  [x1, y0],
  [x1, y1],
  [x0, y1],
];

describe('triangulatePolygon', () => {
  it('triangulates convex and concave polygons in either winding', () => {
    expect(triangulatedArea(rect(0, 0, 4, 3))).toBeCloseTo(12);
    expect(triangulatedArea(rect(0, 0, 4, 3).reverse())).toBeCloseTo(12);
    const lShape: Point2[] = [
      [0, 0],
      [6, 0],
      [6, 2],
      [2, 2],
      [2, 5],
      [0, 5],
    ];
    expect(triangulatedArea(lShape)).toBeCloseTo(polygonArea(lShape));
  });

  it('subtracts one or several holes', () => {
    expect(triangulatedArea(rect(0, 0, 10, 8), [rect(2, 2, 4, 5)])).toBeCloseTo(80 - 6);
    expect(
      triangulatedArea(rect(0, 0, 10, 8), [
        rect(1, 1, 3, 3),
        rect(6, 4, 9, 7).reverse(),
        rect(4, 1, 5, 6),
      ]),
    ).toBeCloseTo(80 - 4 - 9 - 5);
    const lShape: Point2[] = [
      [0, 0],
      [10, 0],
      [10, 4],
      [4, 4],
      [4, 10],
      [0, 10],
    ];
    expect(triangulatedArea(lShape, [rect(1, 6, 3, 8), rect(6, 1, 8, 3)])).toBeCloseTo(
      polygonArea(lShape) - 8,
    );
  });

  it('returns all input vertices and no triangles for degenerate input', () => {
    const result = triangulatePolygon([
      [0, 0],
      [1, 1],
      [2, 2],
    ]);
    expect(result.vertices).toHaveLength(3);
    expect(result.triangles).toEqual([]);
  });
});
