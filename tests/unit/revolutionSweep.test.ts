import { describe, it, expect } from 'vitest';
import { revolutionPolygons, revolutionTriangles } from '@core/geometry/revolution';

const profile: Array<readonly [number, number]> = [
  [1, 0],
  [2, 0],
  [2, 1],
];

describe('revolutionPolygons', () => {
  it('full sweep: segments*n quads, no caps', () => {
    const polys = revolutionPolygons(profile, [0, 0, 1], 2 * Math.PI, 8);
    expect(polys).toHaveLength(8 * 3);
    expect(polys.every((p) => p.length === 4)).toBe(true);
  });

  it('partial sweep: adds reversed start cap and end cap, starts at +X', () => {
    const polys = revolutionPolygons(profile, [0, 0, 1], Math.PI, 4);
    expect(polys).toHaveLength(4 * 3 + 2);
    const start = polys[polys.length - 2]!;
    const end = polys[polys.length - 1]!;
    expect(start[start.length - 1]).toEqual([1, 0, 0]);
    expect(end[0]![0]).toBeCloseTo(-1);
    expect(end[0]![2]).toBeCloseTo(0);
  });

  it('Z axis frame: radial XY, axial Z; origin offsets vertices', () => {
    const [quad] = revolutionPolygons(
      [
        [1, 5],
        [2, 5],
        [2, 6],
      ],
      [0, 0, 1],
      Math.PI / 2,
      1,
      [10, 20, 30],
    );
    expect(quad![0]).toEqual([11, 20, 35]);
    expect(quad![3]![0]).toBeCloseTo(10);
    expect(quad![3]![1]).toBeCloseTo(21);
  });

  it('Y axis frame: radial XZ, axial Y', () => {
    const [quad] = revolutionPolygons(
      [
        [1, 5],
        [2, 5],
        [2, 6],
      ],
      [0, 1, 0],
      Math.PI / 2,
      1,
    );
    expect(quad![0]).toEqual([1, 5, 0]);
    expect(quad![3]![1]).toBeCloseTo(5);
    expect(quad![3]![2]).toBeCloseTo(1);
  });

  it('X axis frame: radial YZ, axial X', () => {
    const [quad] = revolutionPolygons(
      [
        [1, 5],
        [2, 5],
        [2, 6],
      ],
      [1, 0, 0],
      Math.PI / 2,
      1,
    );
    expect(quad![0]).toEqual([5, 1, 0]);
    expect(quad![3]![0]).toBeCloseTo(5);
    expect(quad![3]![2]).toBeCloseTo(1);
  });

  it('degenerate profile (<3 points) yields nothing', () => {
    expect(
      revolutionPolygons(
        [
          [1, 0],
          [2, 0],
        ],
        [0, 0, 1],
        Math.PI,
        4,
      ),
    ).toEqual([]);
    expect(revolutionTriangles([[1, 0]], [0, 0, 1], Math.PI, 4)).toEqual([]);
  });
});

describe('revolutionTriangles', () => {
  it('fan-triangulates: 2 per quad, n-2 per cap', () => {
    expect(revolutionTriangles(profile, [0, 0, 1], 2 * Math.PI, 8)).toHaveLength(8 * 3 * 2);
    expect(revolutionTriangles(profile, [0, 0, 1], Math.PI, 4)).toHaveLength(4 * 3 * 2 + 2);
  });
});
