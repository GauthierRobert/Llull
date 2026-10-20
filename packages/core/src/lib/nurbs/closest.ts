/** Closest-point projection of a point on a NURBS curve or surface: coarse sampling, then clamped Newton iterations on the orthogonality conditions. */

import type { Vec3 } from '../../model/vectors';
import { distance3, dot3, sub3 } from '../vec3';
import { curveDerivatives, curveDomain, evaluateCurve } from './evaluate';
import { surfaceDerivatives, surfaceDomain } from './surface';
import type { NurbsCurveData } from './types';
import type { NurbsSurfaceData } from './surfaceTypes';

export interface CurveProjection {
  readonly t: number;
  readonly point: Vec3;
  readonly distance: number;
}

export interface SurfaceProjection {
  readonly u: number;
  readonly v: number;
  readonly point: Vec3;
  readonly distance: number;
}

const NEWTON_STEPS = 40;
const CURVE_SAMPLES_PER_SPAN = 24;
const SURFACE_SAMPLES_PER_SPAN = 6;
const SURFACE_STARTS = 3;

/** Closest point of `curve` to `target` (the global minimum among the sampled basins). */
export function closestOnCurve(curve: NurbsCurveData, target: Vec3): CurveProjection {
  const [first, last] = curveDomain(curve);
  const count = Math.max(8, (curve.knots.length - 1) * CURVE_SAMPLES_PER_SPAN);
  let [bestT, bestDistance] = [first, Infinity];
  for (let i = 0; i <= count; i++) {
    const t = first + ((last - first) * i) / count;
    const distance = distance3(evaluateCurve(curve, t), target);
    if (distance < bestDistance) [bestT, bestDistance] = [t, distance];
  }
  let t = bestT;
  for (let step = 0; step < NEWTON_STEPS; step++) {
    const [point, d1, d2] = curveDerivatives(curve, t, 2) as [Vec3, Vec3, Vec3];
    const offset = sub3(point, target);
    const gradient = dot3(offset, d1);
    const curvature = dot3(d1, d1) + dot3(offset, d2);
    if (!(Math.abs(curvature) > 1e-14)) break;
    const next = Math.min(last, Math.max(first, t - gradient / curvature));
    if (Math.abs(next - t) < 1e-14 * (last - first)) {
      t = next;
      break;
    }
    t = next;
  }
  const point = evaluateCurve(curve, t);
  const distance = distance3(point, target);
  return distance <= bestDistance ? { t, point, distance } : { t: bestT, point: evaluateCurve(curve, bestT), distance: bestDistance };
}

/** Newton refinement of (u, v) towards the foot point of `target`; returns the best of the start and the result. */
export function refineOnSurface(surface: NurbsSurfaceData, target: Vec3, u0: number, v0: number): SurfaceProjection {
  const [[uMin, uMax], [vMin, vMax]] = surfaceDomain(surface);
  let [u, v] = [u0, v0];
  for (let step = 0; step < NEWTON_STEPS; step++) {
    const d = surfaceDerivatives(surface, u, v, 2);
    const at = (k: number, l: number): Vec3 => (d[k] as Vec3[])[l] as Vec3;
    const offset = sub3(at(0, 0), target);
    const [su, sv] = [at(1, 0), at(0, 1)];
    const [f, g] = [dot3(offset, su), dot3(offset, sv)];
    const a = dot3(su, su) + dot3(offset, at(2, 0));
    const b = dot3(su, sv) + dot3(offset, at(1, 1));
    const c = dot3(sv, sv) + dot3(offset, at(0, 2));
    const determinant = a * c - b * b;
    if (!(Math.abs(determinant) > 1e-18)) break;
    const du = (c * f - b * g) / determinant;
    const dv = (a * g - b * f) / determinant;
    const [nextU, nextV] = [Math.min(uMax, Math.max(uMin, u - du)), Math.min(vMax, Math.max(vMin, v - dv))];
    const moved = Math.abs(nextU - u) + Math.abs(nextV - v);
    [u, v] = [nextU, nextV];
    if (moved < 1e-14 * (uMax - uMin + vMax - vMin)) break;
  }
  const point = (surfaceDerivatives(surface, u, v, 0)[0] as Vec3[])[0] as Vec3;
  const start = (surfaceDerivatives(surface, u0, v0, 0)[0] as Vec3[])[0] as Vec3;
  const [end, begin] = [distance3(point, target), distance3(start, target)];
  return end <= begin ? { u, v, point, distance: end } : { u: u0, v: v0, point: start, distance: begin };
}

/** Coarse parameter grid of a surface, evaluated once so many projections onto the same patch stay cheap. */
export interface SurfaceProbe {
  readonly cells: ReadonlyArray<{ readonly u: number; readonly v: number; readonly point: Vec3 }>;
}

/** Samples `surface` on a grid with the same count in every knot span (6 per span, at least 6 in all). */
export function surfaceProbe(surface: NurbsSurfaceData): SurfaceProbe {
  const [[uMin, uMax], [vMin, vMax]] = surfaceDomain(surface);
  const countU = Math.max(6, (surface.knotsU.length - 1) * SURFACE_SAMPLES_PER_SPAN);
  const countV = Math.max(6, (surface.knotsV.length - 1) * SURFACE_SAMPLES_PER_SPAN);
  const cells: Array<{ u: number; v: number; point: Vec3 }> = [];
  for (let i = 0; i <= countU; i++)
    for (let j = 0; j <= countV; j++) {
      const [u, v] = [uMin + ((uMax - uMin) * i) / countU, vMin + ((vMax - vMin) * j) / countV];
      cells.push({ u, v, point: (surfaceDerivatives(surface, u, v, 0)[0] as Vec3[])[0] as Vec3 });
    }
  return { cells };
}

/** Closest point of `surface` to `target`: the best Newton result over the nearest few cells of the probe grid. */
export function closestOnSurface(surface: NurbsSurfaceData, target: Vec3, probe: SurfaceProbe = surfaceProbe(surface)): SurfaceProjection {
  const nearest: Array<{ u: number; v: number; distance: number }> = [];
  for (const cell of probe.cells) {
    const distance = distance3(cell.point, target);
    if (nearest.length < SURFACE_STARTS || distance < (nearest[nearest.length - 1] as { distance: number }).distance) {
      nearest.push({ u: cell.u, v: cell.v, distance });
      nearest.sort((a, b) => a.distance - b.distance);
      if (nearest.length > SURFACE_STARTS) nearest.pop();
    }
  }
  let best: SurfaceProjection | null = null;
  for (const start of nearest) {
    const refined = refineOnSurface(surface, target, start.u, start.v);
    if (best === null || refined.distance < best.distance) best = refined;
  }
  return best as SurfaceProjection;
}
