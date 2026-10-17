import { describe, expect, it } from 'vitest';
import type { Vec3 } from '@core/model/vectors';
import { fitPlane } from '@cae/thermomech/plane';

describe('fitPlane', () => {
  it('finds an exactly flat rotated plane with zero flatness and the right normal', () => {
    // plane through (1, 2, 3) with normal (1, 2, 2) / 3; in-plane basis
    const normal: Vec3 = [1 / 3, 2 / 3, 2 / 3];
    const u: Vec3 = [2 / 3, 1 / 3, -2 / 3];
    const v: Vec3 = [2 / 3, -2 / 3, 1 / 3];
    const points: Vec3[] = [];
    for (const [a, b] of [
      [0, 0],
      [5, 0],
      [0, 7],
      [5, 7],
      [2.5, 3],
      [-4, 1],
    ] as const)
      points.push([1 + a * u[0] + b * v[0], 2 + a * u[1] + b * v[1], 3 + a * u[2] + b * v[2]]);
    const fit = fitPlane(points);
    expect(fit?.flatness).toBeLessThan(1e-12);
    const dot = Math.abs((fit?.normal[0] ?? 0) * normal[0] + (fit?.normal[1] ?? 0) * normal[1] + (fit?.normal[2] ?? 0) * normal[2]);
    expect(dot).toBeCloseTo(1, 12);
    expect(Math.hypot(...(fit?.normal ?? [0, 0, 0]))).toBeCloseTo(1, 12);
  });

  it('measures the exact flatness of a raised centre point', () => {
    const fit = fitPlane([
      [0, 0, 0],
      [10, 0, 0],
      [10, 10, 0],
      [0, 10, 0],
      [5, 5, 0.2],
    ]);
    // normal is z by symmetry: distances -0.04 (corners) and +0.16 (centre)
    expect(fit?.flatness).toBeCloseTo(0.2, 12);
    expect(fit?.normal[2]).toBeCloseTo(1, 12);
    expect(fit?.centroid).toEqual([5, 5, 0.04]);
  });

  it('is deterministic and refuses degenerate clouds', () => {
    const points: Vec3[] = [
      [0, 0, 0],
      [1, 0.1, 0],
      [0, 1, 0.3],
      [1, 1, 0.1],
      [0.5, 0.2, 0.7],
    ];
    expect(fitPlane(points)).toEqual(fitPlane(points));
    expect(
      fitPlane([
        [0, 0, 0],
        [1, 1, 1],
      ]),
    ).toBeNull();
    expect(
      fitPlane([
        [0, 0, 0],
        [1, 1, 1],
        [2, 2, 2],
        [3, 3, 3],
      ]),
    ).toBeNull();
    expect(
      fitPlane([
        [1, 1, 1],
        [1, 1, 1],
        [1, 1, 1],
      ]),
    ).toBeNull();
  });
});
