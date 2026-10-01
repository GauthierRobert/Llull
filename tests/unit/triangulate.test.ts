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

  it('never bridges through a hole when bridge candidates tie', () => {
    const result = triangulatePolygon(rect(0, 0, 6000, 4000), [rect(1000, 1000, 2000, 2000)]);
    expect(result.complete).toBe(true);
    expect(triangulatedArea(rect(0, 0, 6000, 4000), [rect(1000, 1000, 2000, 2000)])).toBeCloseTo(
      23e6,
    );
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

describe('triangulatePolygon — randomized', () => {
  it('covers exactly outer − holes for 200 random slabs with 1–3 openings', () => {
    let seed = 12345;
    const random = (): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    for (let trial = 0; trial < 200; trial++) {
      const width = 4000 + Math.round(random() * 20) * 500;
      const depth = 3000 + Math.round(random() * 16) * 500;
      const holes: Point2[][] = [];
      for (let attempt = 0; attempt < 10 && holes.length < 1 + (trial % 3); attempt++) {
        const x0 = 250 + Math.round(random() * ((width - 2000) / 250)) * 250;
        const y0 = 250 + Math.round(random() * ((depth - 2000) / 250)) * 250;
        const candidate = rect(
          x0,
          y0,
          x0 + 500 + Math.round(random() * 4) * 250,
          y0 + 500 + Math.round(random() * 4) * 250,
        );
        const [cx1, cy1] = candidate[2]!;
        const clear = holes.every((hole) => {
          const [hx0, hy0] = hole[0]!;
          const [hx1, hy1] = hole[2]!;
          return cx1 + 100 < hx0 || x0 > hx1 + 100 || cy1 + 100 < hy0 || y0 > hy1 + 100;
        });
        if (clear && cx1 < width - 100 && cy1 < depth - 100) holes.push(candidate);
      }
      const outer = rect(0, 0, width, depth);
      const result = triangulatePolygon(outer, holes);
      expect(result.complete, `trial ${trial}`).toBe(true);
      const expected = width * depth - holes.reduce((sum, hole) => sum + polygonArea(hole), 0);
      expect(triangulatedArea(outer, holes)).toBeCloseTo(expected, 3);
    }
  });
});
