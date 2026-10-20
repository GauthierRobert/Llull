import { describe, expect, it } from 'vitest';
import { curveComb, surfaceMapColors, SURFACE_MAP_MODES } from '@core/geometry/surfaceAnalysis/overlay';
import { tessellateSheet } from '@core/geometry/nurbsSurface';
import type { NurbsCurveData } from '@lib/nurbs/types';
import type { NurbsSurfaceData } from '@lib/nurbs/surfaceTypes';
import { cylinderSurface, sphereSurface } from '../../helpers/revolvedSurfaces';

const SQRT_HALF = Math.SQRT1_2;

const circle = (radius: number): NurbsCurveData => ({
  degree: 2,
  poles: [
    [radius, 0, 0],
    [radius, radius, 0],
    [0, radius, 0],
    [-radius, radius, 0],
    [-radius, 0, 0],
    [-radius, -radius, 0],
    [0, -radius, 0],
    [radius, -radius, 0],
    [radius, 0, 0],
  ],
  weights: [1, SQRT_HALF, 1, SQRT_HALF, 1, SQRT_HALF, 1, SQRT_HALF, 1],
  knots: [0, 0.25, 0.5, 0.75, 1],
  multiplicities: [3, 2, 2, 2, 3],
});

const grid = (surface: NurbsSurfaceData, n: number): Array<readonly [number, number]> => {
  const [u0, u1, v0, v1] = [surface.knotsU[0]!, surface.knotsU.at(-1)!, surface.knotsV[0]!, surface.knotsV.at(-1)!];
  return Array.from(
    { length: n * n },
    (_, k) => [u0 + ((u1 - u0) * (k % n)) / (n - 1), v0 + ((v1 - v0) * Math.floor(k / n)) / (n - 1)] as const,
  );
};

describe('curve comb overlay', () => {
  it('a circle of radius 2 has equal teeth of length scale / 2 pointing away from the centre', () => {
    const comb = curveComb(circle(2), 21, 0.6);
    expect(comb.maxCurvature).toBeCloseTo(0.5, 9);
    for (let k = 0; k < 21; k++) {
      const [px, py, pz, tx, ty, tz] = comb.teeth.slice(6 * k, 6 * k + 6) as [number, number, number, number, number, number];
      expect(Math.hypot(px, py)).toBeCloseTo(2, 9);
      expect(Math.hypot(tx - px, ty - py, tz - pz)).toBeCloseTo(0.3, 9);
      expect(Math.hypot(tx, ty)).toBeCloseTo(2.3, 9);
    }
    expect(comb.envelope).toHaveLength(63);
  });

  it('chooses a scale making the longest tooth 15 % of the extent, and has no teeth to speak of on a line', () => {
    const auto = curveComb(circle(2), 21, null);
    const [px, py, pz, tx, ty, tz] = auto.teeth.slice(0, 6) as [number, number, number, number, number, number];
    expect(Math.hypot(tx - px, ty - py, tz - pz)).toBeCloseTo(0.15 * 4, 6);
    const line = curveComb(
      {
        degree: 1,
        poles: [
          [0, 0, 0],
          [5, 0, 0],
        ],
        knots: [0, 1],
        multiplicities: [2, 2],
      },
      9,
      null,
    );
    expect(line.maxCurvature).toBe(0);
  });
});

describe('surface colour maps', () => {
  it('Gaussian map of a sphere is one colour away from the poles, grey at a pole', () => {
    const colors = surfaceMapColors(sphereSurface(10), grid(sphereSurface(10), 9), 'gaussian');
    expect(colors).toHaveLength(9 * 9 * 3);
    const [r, g, b] = [colors[3 * 40]!, colors[3 * 40 + 1]!, colors[3 * 40 + 2]!];
    expect(r).toBe(1);
    expect(g).toBeCloseTo(0, 9);
    expect(b).toBeCloseTo(0, 9);
    expect(colors.slice(0, 3)).toEqual([0.6, 0.6, 0.6]);
  });

  it('mean map is diverging about zero (a cylinder is one signed colour, a plane-like grid white)', () => {
    const colors = surfaceMapColors(cylinderSurface(2, 5), grid(cylinderSurface(2, 5), 5), 'mean');
    expect(new Set(colors.map((c) => c.toFixed(6))).size).toBeLessThanOrEqual(3);
  });

  it('zebra alternates dark and light stripes over a sphere', () => {
    const colors = surfaceMapColors(sphereSurface(10), grid(sphereSurface(10), 25), 'zebra', { stripes: 6 });
    const levels = new Set(colors.filter((_, k) => k % 3 === 0));
    expect([...levels].sort()).toEqual([0.08, 0.6, 0.97].filter((level) => levels.has(level)));
    expect(levels.has(0.08) && levels.has(0.97)).toBe(true);
  });

  it('draft map: a vertical wall against a pull along its axis is amber (0 degrees); a sphere shows undercut, amber and green', () => {
    const wall = surfaceMapColors(cylinderSurface(2, 5), grid(cylinderSurface(2, 5), 5), 'draft', { direction: [0, 0, 1] });
    expect(new Set(wall.map((c) => c.toFixed(2)))).toContain('0.95');
    const ball = surfaceMapColors(sphereSurface(10), grid(sphereSurface(10), 13), 'draft', { direction: [0, 0, 1] });
    const reds = ball.filter((_, k) => k % 3 === 0 && ball[k + 1] === 0.1).length;
    const greens = ball.filter((_, k) => k % 3 === 0 && ball[k + 1] === 0.7).length;
    expect(reds).toBeGreaterThan(5);
    expect(greens).toBeGreaterThan(5);
    const flipped = surfaceMapColors(sphereSurface(10), grid(sphereSurface(10), 13), 'draft', { direction: [0, 0, 1], flip: true });
    expect(flipped).not.toEqual(ball);
  });

  it('lists the four modes and tessellateSheet returns one (u, v) per vertex, trimmed or not', () => {
    expect(SURFACE_MAP_MODES).toEqual(['gaussian', 'mean', 'zebra', 'draft']);
    const whole = tessellateSheet(sphereSurface(10), undefined, 4);
    expect(whole.uvs.length / 2).toBe(whole.positions.length / 3);
    const loop = {
      outer: true,
      polygon: Array.from(
        { length: 16 },
        (_, k) => [0.5 + 0.2 * Math.cos((2 * Math.PI * k) / 16), 0.5 + 0.2 * Math.sin((2 * Math.PI * k) / 16)] as const,
      ),
    };
    const trimmed = tessellateSheet(sphereSurface(10), [loop], 4);
    expect(trimmed.uvs.length / 2).toBe(trimmed.positions.length / 3);
    expect(trimmed.indices.length).toBeGreaterThan(0);
  });
});
