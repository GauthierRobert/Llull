/**
 * Deformation of NURBS curves and sheets (01 DEF §5.8, FR-DEF-17): an affine map moves the poles (NURBS are affinely invariant, so it is exact); any
 * other map samples the deformed geometry and refits it with the existing interpolation / approximation machinery of `lib/nurbs`, doubling the
 * samples until the fit passes within tolerance at points BETWEEN the samples.
 * @invariant the result is a clamped non-rational NURBS within `tolerance` of the true deformed geometry at every checked point
 */

import type { Vec3 } from '../../model/vectors';
import { approximatePoints } from '../../lib/nurbs/approximate';
import { closestOnCurve, closestOnSurface, surfaceProbe } from '../../lib/nurbs/closest';
import { curveDomain, evaluateCurve } from '../../lib/nurbs/evaluate';
import { interpolateGrid } from '../../lib/nurbs/surfaceFit';
import { evaluateSurface, surfaceDomain } from '../../lib/nurbs/surface';
import type { NurbsSurfaceData } from '../../lib/nurbs/surfaceTypes';
import type { NurbsCurveData } from '../../lib/nurbs/types';

type Map3 = (p: Vec3) => Vec3;

export interface Refit<T> {
  readonly data: T;
  /** Largest checked distance of the fit from the deformed geometry (document units). */
  readonly maxError: number;
  readonly samples: number;
}

/** Samples per curve before refinement, and the most it tries. */
const START_SAMPLES = 64;
const MAX_SAMPLES = 4096;
const MAX_CURVE_POLES = 400;
const START_GRID = 9;
const MAX_GRID = 65;
/** Cell middles checked per refinement level (a stride over the cells beyond this: each check is a foot-point search). */
const MAX_CHECKS = 200;

/** The curve with every pole mapped by the affine map `map` (exact; weights and knots kept). */
export const mapPoles = (curve: NurbsCurveData, map: Map3): NurbsCurveData => ({ ...curve, poles: curve.poles.map(map) });

/** The sheet with every pole mapped by the affine map `map` (exact). */
export const mapSurfacePoles = (surface: NurbsSurfaceData, map: Map3): NurbsSurfaceData => ({
  ...surface,
  poles: surface.poles.map((row) => row.map(map)),
});

/**
 * `curve` deformed by `map`, refitted at the same degree or up to 5.
 * @failure no fit within `tolerance` below 400 poles / 4096 samples -> null
 */
export function refitCurve(curve: NurbsCurveData, map: Map3, tolerance: number): Refit<NurbsCurveData> | null {
  const [first, last] = curveDomain(curve);
  for (let count = Math.max(START_SAMPLES, 8 * curve.poles.length); count <= MAX_SAMPLES; count *= 2) {
    const at = (i: number, n: number): Vec3 => map(evaluateCurve(curve, first + ((last - first) * i) / n));
    const points = Array.from({ length: count + 1 }, (_, i) => at(i, count));
    const fit = approximatePoints(points, {
      tolerance: tolerance / 2,
      degreeMin: Math.min(curve.degree, 5),
      degreeMax: Math.max(Math.min(curve.degree, 5), 3),
      maxPoles: Math.min(MAX_CURVE_POLES, points.length),
    });
    if (fit === null) continue;
    let worst = 0;
    for (let i = 0; i < count; i++) worst = Math.max(worst, closestOnCurve(fit.curve, at(2 * i + 1, 2 * count)).distance);
    if (worst <= tolerance) return { data: fit.curve, maxError: Math.max(worst, fit.maxDeviation), samples: count };
  }
  return null;
}

/**
 * `surface` deformed by `map`, interpolated through a grid of samples (degrees at most 5), the grid doubled until the cell middles are within tolerance.
 * @failure no fit within `tolerance` up to a 65 x 65 grid -> null
 */
export function refitSurface(surface: NurbsSurfaceData, map: Map3, tolerance: number): Refit<NurbsSurfaceData> | null {
  const [[u0, u1], [v0, v1]] = surfaceDomain(surface);
  const [degreeU, degreeV] = [Math.min(Math.max(surface.degreeU, 2), 5), Math.min(Math.max(surface.degreeV, 2), 5)];
  for (let n = START_GRID; n <= MAX_GRID; n = 2 * n - 1) {
    const point = (i: number, j: number, steps: number): Vec3 =>
      map(evaluateSurface(surface, u0 + ((u1 - u0) * i) / steps, v0 + ((v1 - v0) * j) / steps));
    const grid = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => point(i, j, n - 1)));
    const fit = interpolateGrid(grid, degreeU, degreeV);
    if ('code' in fit) continue;
    let worst = 0;
    const probe = surfaceProbe(fit.surface);
    const cells = (n - 1) * (n - 1);
    const stride = Math.max(1, Math.ceil(cells / MAX_CHECKS));
    for (let cell = 0; cell < cells; cell += stride) {
      const [i, j] = [Math.floor(cell / (n - 1)), cell % (n - 1)];
      worst = Math.max(worst, closestOnSurface(fit.surface, point(2 * i + 1, 2 * j + 1, 2 * (n - 1)), probe).distance);
    }
    if (worst <= tolerance) return { data: fit.surface, maxError: worst, samples: n * n };
  }
  return null;
}
