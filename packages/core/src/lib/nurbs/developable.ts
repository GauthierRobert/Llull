/**
 * Developable rulings between two curves (SWG M7): the surface of straight lines joining A(u) to B(v(u)) with det[A'(u), B'(v), B(v) - A(u)] = 0,
 * i.e. the tangent planes along a ruling coincide (Gaussian curvature 0). Curves whose parameter pairing is already developable (a cone frustum
 * between two coaxial circles with equal knots and weights) are returned exactly; others are paired by Newton continuation and refitted.
 */

import type { Vec3 } from '../../model/vectors';
import { cross3, distance3, dot3, len3, sub3 } from '../vec3';
import { curveDerivatives, curveDomain, evaluateCurve } from './evaluate';
import { interpolatePoints } from './interpolate';
import { ruledPatch } from './ruled';
import type { NurbsSurfaceData } from './surfaceTypes';
import type { NurbsCurveData } from './types';

/** Rulings sampled along A. */
const RULINGS = 96;
/** Relative triple product below which the tangent planes of neighbouring rulings count as one. */
const EXACT_RESIDUAL = 1e-9;
const ROOT_SAMPLES = 400;

/** Triple product det[A'(u), B'(v), B(v) - A(u)] and its normalisation |A'| |B'| |ruling|. */
function tripleProduct(a: NurbsCurveData, b: NurbsCurveData, u: number, v: number): { value: number; scale: number } {
  const [pa, da] = curveDerivatives(a, u, 1) as [Vec3, Vec3];
  const [pb, db] = curveDerivatives(b, v, 1) as [Vec3, Vec3];
  const ruling = sub3(pb, pa);
  return { value: dot3(cross3(da, db), ruling), scale: Math.max(len3(da) * len3(db) * len3(ruling), 1e-300) };
}

/** Domain parameter of `curve` at normalised position t (0..1). */
const along = (curve: NurbsCurveData, t: number): number => {
  const [lo, hi] = curveDomain(curve);
  return lo + (hi - lo) * t;
};

/** Largest relative triple product of the parameter pairing of two curves (0 = every parameter ruling developable). */
function pairingResidual(a: NurbsCurveData, b: NurbsCurveData): number {
  let worst = 0;
  for (let k = 0; k <= 64; k++) {
    const { value, scale } = tripleProduct(a, b, along(a, k / 64), along(b, k / 64));
    worst = Math.max(worst, Math.abs(value) / scale);
  }
  return worst;
}

/** Every v on `b` at which the triple product with A(u) vanishes (sign changes of a dense scan, bisected). */
function rulingRoots(a: NurbsCurveData, b: NurbsCurveData, u: number): number[] {
  const [lo, hi] = curveDomain(b);
  const value = (v: number): number => {
    const triple = tripleProduct(a, b, u, v);
    return triple.value / triple.scale;
  };
  const roots: number[] = [];
  let previous = value(lo);
  for (let k = 1; k <= ROOT_SAMPLES; k++) {
    const v1 = lo + ((hi - lo) * k) / ROOT_SAMPLES;
    const next = value(v1);
    if (previous === 0 || previous * next < 0) {
      let [x0, x1, f0] = [lo + ((hi - lo) * (k - 1)) / ROOT_SAMPLES, v1, previous];
      for (let step = 0; step < 60; step++) {
        const mid = (x0 + x1) / 2;
        const fm = value(mid);
        if (f0 * fm <= 0) x1 = mid;
        else [x0, f0] = [mid, fm];
      }
      roots.push((x0 + x1) / 2);
    }
    previous = next;
  }
  return roots;
}

export type DevelopableResult =
  | { readonly surface: NurbsSurfaceData; readonly exact: boolean }
  | { readonly code: 'SWG_NOT_DEVELOPABLE'; readonly message: string };

/**
 * The developable ruled surface between two curves.
 * @invariant an exact result (`exact: true`) is the parameter-coupled ruled patch itself
 * @failure no ruling through a sample of A, rulings that run backwards along B or do not reach its end -> SWG_NOT_DEVELOPABLE
 */
export function developableSurface(a: NurbsCurveData, b: NurbsCurveData): DevelopableResult {
  const exact = ruledPatch(a, b);
  if (typeof exact === 'string') return { code: 'SWG_NOT_DEVELOPABLE', message: exact };
  if (pairingResidual(a, b) <= EXACT_RESIDUAL) return { surface: exact, exact: true };
  const [bLo, bHi] = curveDomain(b);
  const period = bHi - bLo;
  const closedB = distance3(evaluateCurve(b, bLo), evaluateCurve(b, bHi)) <= 1e-9 * Math.max(period, 1);
  const pointsA: Vec3[] = [];
  const pointsB: Vec3[] = [];
  let v = bLo;
  let first = bLo;
  for (let k = 0; k <= RULINGS; k++) {
    const u = along(a, k / RULINGS);
    const at = `fraction ${(k / RULINGS).toFixed(4)}`;
    const roots = rulingRoots(a, b, u);
    if (roots.length === 0) return { code: 'SWG_NOT_DEVELOPABLE', message: `no developable ruling leaves the first curve at ${at}` };
    // the next root along B (a closed B wraps round once): never behind the previous one, and not a jump of half a turn
    const candidates = roots.flatMap((root) => (closedB ? [root - period, root, root + period, root + 2 * period] : [root]));
    const forward = candidates.filter((candidate) => candidate >= v - 1e-6 * period).sort((x, y) => x - y)[0];
    if (forward === undefined || (k > 0 && forward - v > 0.5 * period))
      return { code: 'SWG_NOT_DEVELOPABLE', message: `the developable rulings run backwards along the second curve at ${at}` };
    v = k === 0 ? roots.reduce((best, root) => (Math.abs(root - bLo) < Math.abs(best - bLo) ? root : best)) : forward;
    if (k === 0) first = v;
    const wrapped = closedB ? bLo + ((((v - bLo) % period) + period) % period) : v;
    pointsA.push(evaluateCurve(a, u));
    pointsB.push(evaluateCurve(b, wrapped));
  }
  const reach = closedB ? v - first : v - bLo;
  if (closedB ? Math.abs(reach - period) > 1e-3 * period : Math.abs(bHi - v) > 1e-3 * period || Math.abs(first - bLo) > 1e-3 * period)
    return { code: 'SWG_NOT_DEVELOPABLE', message: 'the developable rulings do not run across the whole second curve' };
  const fitA = interpolatePoints(pointsA, { degree: 3, parameterization: 'uniform' });
  const fitB = interpolatePoints(pointsB, { degree: 3, parameterization: 'uniform' });
  if ('code' in fitA || 'code' in fitB)
    return { code: 'SWG_NOT_DEVELOPABLE', message: 'the ruling endpoints coincide, so they cannot be refitted' };
  const surface = ruledPatch(fitA.curve, fitB.curve);
  return typeof surface === 'string' ? { code: 'SWG_NOT_DEVELOPABLE', message: surface } : { surface, exact: false };
}
