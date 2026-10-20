import { describe, expect, it } from 'vitest';
import type { Vec3 } from '@core/model/types';
import { evaluateSurface, isoCurve, surfaceDerivatives, surfaceDomain } from '@lib/nurbs/surface';
import { surfaceSample } from '@lib/nurbs/surfaceCurvature';
import { closestOnCurve, closestOnSurface } from '@lib/nurbs/closest';
import { elevateSurface, extractSubSurface, insertSurfaceKnot, reverseSurface, transposeSurface } from '@lib/nurbs/surfaceEdit';
import { compatibleCurves, interpolateGrid, skinCurves } from '@lib/nurbs/surfaceFit';
import { surfaceViolation, type NurbsSurfaceData } from '@lib/nurbs/surfaceTypes';
import { evaluateCurve } from '@lib/nurbs/evaluate';
import { conicCurve } from '@lib/nurbs/conic';
import type { NurbsCurveData } from '@lib/nurbs/types';
import { cylinderSurface, sphereSurface, torusSurface } from '../../helpers/revolvedSurfaces';

const norm = (p: Vec3): number => Math.hypot(p[0], p[1], p[2]);
const dist = (a: Vec3, b: Vec3): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** Largest distance between two surfaces over a (u, v) grid of the first one's domain. */
function maxDifference(a: NurbsSurfaceData, b: NurbsSurfaceData, steps = 9): number {
  const [[u0, u1], [v0, v1]] = surfaceDomain(a);
  let worst = 0;
  for (let i = 0; i <= steps; i++)
    for (let j = 0; j <= steps; j++) {
      const [u, v] = [u0 + ((u1 - u0) * i) / steps, v0 + ((v1 - v0) * j) / steps];
      worst = Math.max(worst, dist(evaluateSurface(a, u, v), evaluateSurface(b, u, v)));
    }
  return worst;
}

describe('analytic surfaces (VC-SRF-05)', () => {
  it('the helper surfaces are valid patches and lie on their quadrics', () => {
    for (const surface of [sphereSurface(10), cylinderSurface(5, 8), torusSurface(5, 2)]) expect(surfaceViolation(surface)).toBeNull();
    const sphere = sphereSurface(10);
    for (const [u, v] of [
      [0.13, 0.31],
      [0.6, 0.77],
    ] as const)
      expect(norm(evaluateSurface(sphere, u, v))).toBeCloseTo(10, 12);
  });

  it('sphere R 10: K = 0.01, k1 = k2, |H| = 0.1 at several points', () => {
    const sphere = sphereSurface(10);
    for (const [u, v] of [
      [0.3 / (2 * Math.PI), 0.3],
      [0.3 / (2 * Math.PI), 0.5],
      [0.62, 0.8],
    ] as const) {
      const sample = surfaceSample(sphere, u, v);
      expect(sample.degenerate).toBe(false);
      expect(Math.abs(sample.gaussian - 0.01)).toBeLessThan(1e-9);
      expect(Math.abs(Math.abs(sample.mean) - 0.1)).toBeLessThan(1e-9);
      expect(Math.abs(Math.abs(sample.k1) - 0.1)).toBeLessThan(1e-7);
      expect(Math.abs(Math.abs(sample.k2) - 0.1)).toBeLessThan(1e-7);
    }
  });

  it('flags the poles of the sphere as degenerate', () => {
    expect(surfaceSample(sphereSurface(10), 0.3, 0).degenerate).toBe(true);
  });

  it('cylinder R 5: k = (0.2, 0), K = 0, |H| = 0.1', () => {
    const sample = surfaceSample(cylinderSurface(5, 8), 0.37, 0.4);
    expect(Math.abs(sample.gaussian)).toBeLessThan(1e-9);
    expect(Math.abs(Math.abs(sample.mean) - 0.1)).toBeLessThan(1e-9);
    const [big, small] = [Math.max(Math.abs(sample.k1), Math.abs(sample.k2)), Math.min(Math.abs(sample.k1), Math.abs(sample.k2))];
    expect(big).toBeCloseTo(0.2, 9);
    expect(small).toBeLessThan(1e-9);
  });

  it('torus R 5 / r 2: K = cos(phi) / (r (R + r cos(phi))) and |H| = (R + 2 r cos(phi)) / (2 r (R + r cos(phi)))', () => {
    const torus = torusSurface(5, 2);
    for (const [u, v] of [
      [0.1, 0],
      [0.1, 0.25],
      [0.1, 0.4],
      [0.1, 0.5],
      [0.7, 0.9],
    ] as const) {
      const sample = surfaceSample(torus, u, v);
      const rho = Math.hypot(sample.point[0], sample.point[1]);
      const cosPhi = (rho - 5) / 2;
      expect(Math.abs(sample.gaussian - cosPhi / (2 * (5 + 2 * cosPhi)))).toBeLessThan(1e-9);
      expect(Math.abs(Math.abs(sample.mean) - (5 + 4 * cosPhi) / (4 * (5 + 2 * cosPhi)))).toBeLessThan(1e-9);
    }
    expect(surfaceSample(torus, 0.1, 0).gaussian).toBeCloseTo(1 / 14, 9);
    expect(surfaceSample(torus, 0.1, 0.5).gaussian).toBeCloseTo(-1 / 6, 9);
  });

  it('derivatives match central differences', () => {
    const sphere = sphereSurface(10);
    const [u, v, h] = [0.31, 0.42, 1e-5];
    const su = (surfaceDerivatives(sphere, u, v, 1)[1] as Vec3[])[0] as Vec3;
    const forward = evaluateSurface(sphere, u + h, v);
    const backward = evaluateSurface(sphere, u - h, v);
    for (let c = 0; c < 3; c++) expect(((forward[c] as number) - (backward[c] as number)) / (2 * h)).toBeCloseTo(su[c] as number, 4);
  });
});

describe('surface edits keep the shape', () => {
  const patch = (): NurbsSurfaceData => {
    const grid: Vec3[][] = Array.from({ length: 5 }, (_, i) =>
      Array.from({ length: 6 }, (_, j) => [i, j, Math.sin(i * 0.7) * Math.cos(j * 0.5)] as Vec3),
    );
    const fitted = interpolateGrid(grid, 3, 3);
    if ('code' in fitted) throw new Error(fitted.message);
    return fitted.surface;
  };

  it('insertSurfaceKnot, elevateSurface, transpose and reverse describe the same surface', () => {
    const base = patch();
    const inserted = insertSurfaceKnot(base, 'u', 0.5, 1);
    const raised = elevateSurface(base, 'v', 1);
    expect(typeof inserted).not.toBe('string');
    expect(typeof raised).not.toBe('string');
    expect(maxDifference(base, inserted as NurbsSurfaceData)).toBeLessThan(1e-10);
    expect(maxDifference(base, raised as NurbsSurfaceData)).toBeLessThan(1e-9);
    const swapped = transposeSurface(base);
    expect(dist(evaluateSurface(swapped, 0.4, 0.7), evaluateSurface(base, 0.7, 0.4))).toBeLessThan(1e-12);
    const reversed = reverseSurface(base, 'v');
    expect(dist(evaluateSurface(reversed, 0.3, 0.2), evaluateSurface(base, 0.3, 0.8))).toBeLessThan(1e-10);
  });

  it('rational patches stay exact under knot insertion and degree elevation', () => {
    const sphere = sphereSurface(10);
    const inserted = insertSurfaceKnot(sphere, 'v', 0.3, 1) as NurbsSurfaceData;
    expect(maxDifference(sphere, inserted)).toBeLessThan(1e-9);
    const raised = elevateSurface(cylinderSurface(5, 8), 'u', 1) as NurbsSurfaceData;
    expect(maxDifference(cylinderSurface(5, 8), raised)).toBeLessThan(1e-9);
  });

  it('extractSubSurface reproduces the original inside the rectangle and refuses bad intervals', () => {
    const base = patch();
    const sub = extractSubSurface(base, [0.2, 0.7], [0.1, 0.9]);
    expect(typeof sub).not.toBe('string');
    const part = sub as NurbsSurfaceData;
    expect(surfaceViolation(part)).toBeNull();
    for (const [u, v] of [
      [0.2, 0.1],
      [0.45, 0.5],
      [0.7, 0.9],
      [0.33, 0.77],
    ] as const)
      expect(dist(evaluateSurface(part, u, v), evaluateSurface(base, u, v))).toBeLessThan(1e-10);
    expect(typeof extractSubSurface(base, [0.7, 0.2], [0, 1])).toBe('string');
    expect(typeof extractSubSurface(base, [0, 1.5], [0, 1])).toBe('string');
    const whole = extractSubSurface(base, [0, 1], [0, 1]) as NurbsSurfaceData;
    expect(maxDifference(base, whole)).toBeLessThan(1e-12);
    const rationalPart = extractSubSurface(sphereSurface(10), [0.1, 0.6], [0.2, 0.7]) as NurbsSurfaceData;
    expect(norm(evaluateSurface(rationalPart, 0.3, 0.4))).toBeCloseTo(10, 9);
  });

  it('isoCurve is exact', () => {
    const sphere = sphereSurface(10);
    const curve = isoCurve(sphere, 'u', 0.37);
    for (const v of [0, 0.2, 0.55, 1]) expect(dist(evaluateCurve(curve, v), evaluateSurface(sphere, 0.37, v))).toBeLessThan(1e-12);
    const across = isoCurve(sphere, 'v', 0.4);
    expect(dist(evaluateCurve(across, 0.9), evaluateSurface(sphere, 0.9, 0.4))).toBeLessThan(1e-12);
  });
});

describe('closest point', () => {
  it('projects onto a sphere and a curve', () => {
    const sphere = sphereSurface(10);
    const hit = closestOnSurface(sphere, [30, 0, 0]);
    expect(hit.distance).toBeCloseTo(20, 7);
    expect(hit.point[0]).toBeCloseTo(10, 6);
    const arc = conicCurve([1, 0, 0], [1, 1, 0], [0, 1, 0], Math.SQRT2 - 1);
    const near = closestOnCurve(arc, [3, 3, 0]);
    expect(near.distance).toBeCloseTo(Math.hypot(3, 3) - 1, 8);
  });
});

describe('interpolateGrid and skinCurves', () => {
  it('interpolateGrid passes through every grid point (VC-SRF-25)', () => {
    const grid: Vec3[][] = Array.from({ length: 6 }, (_, i) =>
      Array.from({ length: 7 }, (_, j) => [i * 2, j * 1.5, 0.3 * Math.sin(i) * Math.cos(j * 0.8)] as Vec3),
    );
    const fit = interpolateGrid(grid, 3, 3);
    expect('code' in fit).toBe(false);
    const { surface, residual } = fit as { surface: NurbsSurfaceData; residual: number };
    expect(residual).toBeLessThan(1e-9);
    for (const row of grid) for (const point of row) expect(closestOnSurface(surface, point).distance).toBeLessThan(1e-7);
  });

  it('interpolateGrid refuses ragged or too small grids and bad degrees', () => {
    expect(
      interpolateGrid(
        [
          [
            [0, 0, 0],
            [1, 0, 0],
          ],
          [[0, 1, 0]],
        ],
        1,
        1,
      ),
    ).toMatchObject({ code: 'SRF_POINTS_INSUFFICIENT' });
    expect(
      interpolateGrid(
        [
          [
            [0, 0, 0],
            [1, 0, 0],
          ],
          [
            [0, 1, 0],
            [1, 1, 0],
          ],
        ],
        3,
        3,
      ),
    ).toMatchObject({ code: 'SRF_POINTS_INSUFFICIENT' });
    expect(interpolateGrid([[[0, 0, 0]]], 9, 1)).toMatchObject({ code: 'SRF_NURBS_INVALID' });
  });

  const circleAt = (z: number, radius: number): NurbsCurveData => ({
    degree: 2,
    poles: [
      [radius, 0, z],
      [radius, radius, z],
      [0, radius, z],
      [-radius, radius, z],
      [-radius, 0, z],
      [-radius, -radius, z],
      [0, -radius, z],
      [radius, -radius, z],
      [radius, 0, z],
    ],
    weights: [1, Math.SQRT1_2, 1, Math.SQRT1_2, 1, Math.SQRT1_2, 1, Math.SQRT1_2, 1],
    knots: [0, 0.25, 0.5, 0.75, 1],
    multiplicities: [3, 2, 2, 2, 3],
  });

  it('skinCurves keeps rational sections exact and reproduces each section at its parameter', () => {
    const skin = skinCurves([circleAt(0, 1), circleAt(2, 2), circleAt(5, 1.5)], 2);
    expect('code' in skin).toBe(false);
    const surface = skin as NurbsSurfaceData;
    expect(surfaceViolation(surface)).toBeNull();
    for (const u of [0, 0.13, 0.5, 0.91]) {
      const point = evaluateSurface(surface, u, 0);
      expect(Math.hypot(point[0], point[1])).toBeCloseTo(1, 9);
      expect(point[2]).toBeCloseTo(0, 9);
      const top = evaluateSurface(surface, u, 1);
      expect(Math.hypot(top[0], top[1])).toBeCloseTo(1.5, 9);
      expect(top[2]).toBeCloseTo(5, 9);
    }
  });

  it('skinCurves and compatibleCurves refuse what cannot be skinned', () => {
    expect(skinCurves([circleAt(0, 1)], 1)).toMatchObject({ code: 'SRF_POINTS_INSUFFICIENT' });
    expect(skinCurves([circleAt(0, 1), circleAt(1, 1)], 3)).toMatchObject({ code: 'SRF_NURBS_INVALID' });
    const line: NurbsCurveData = {
      degree: 1,
      poles: [
        [0, 0, 0],
        [1, 0, 0],
      ],
      knots: [0, 1],
      multiplicities: [2, 2],
    };
    expect(typeof compatibleCurves([line, circleAt(0, 1)])).toBe('string');
  });

  it('compatibleCurves gives equal degree, knots and pole counts', () => {
    const quad: NurbsCurveData = {
      degree: 2,
      poles: [
        [0, 0, 0],
        [1, 1, 0],
        [2, 0, 0],
      ],
      knots: [0, 1],
      multiplicities: [3, 3],
    };
    const cubic: NurbsCurveData = {
      degree: 3,
      poles: [
        [0, 1, 0],
        [1, 2, 0],
        [2, 2, 0],
        [3, 1, 0],
        [4, 1, 0],
      ],
      knots: [0, 0.4, 1],
      multiplicities: [4, 1, 4],
    };
    const result = compatibleCurves([quad, cubic]) as NurbsCurveData[];
    expect(result[0]!.degree).toBe(3);
    expect(result[0]!.knots).toEqual(result[1]!.knots);
    expect(result[0]!.poles).toHaveLength(result[1]!.poles.length);
    for (const t of [0.1, 0.5, 0.9]) expect(dist(evaluateCurve(result[0]!, t), evaluateCurve(quad, t))).toBeLessThan(1e-9);
  });
});
