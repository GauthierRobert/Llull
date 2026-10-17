/**
 * Diffuse view factors between planar triangles by contour integration (PHY-03 TR-THM-20, TECHNICAL_SPEC 5.4):
 * F_ij = 1/(2 pi A_i) ∮∮ ln(r) dl_i · dl_j with both contours counter-clockwise about their own (emitting-side) normal.
 * Each edge pair is integrated exactly along one edge (closed-form antiderivative of ln r, including collinear edges) and with
 * 8-point Gauss-Legendre panels, adaptively bisected, along the other (touching edges make the outer integrand non-smooth).
 */

import type { Vec3 } from '../model/vectors';
import { add3, cross3, dot3, len3, scale3, sub3 } from './vec3';

export interface Facet {
  readonly corners: readonly [Vec3, Vec3, Vec3];
  readonly normal: Vec3;
  readonly centroid: Vec3;
  readonly area: number;
}

const NODES = [0.1834346424956498, 0.525532409916329, 0.7966664774136267, 0.9602898564975363] as const;
const WEIGHTS = [0.362683783378362, 0.3137066458778873, 0.2223810344533745, 0.1012285362903763] as const;
const TOLERANCE = 1e-13;
const MAX_DEPTH = 48;

/** Facet from three corners (counter-clockwise about the emitting side). */
export function makeFacet(a: Vec3, b: Vec3, c: Vec3): Facet {
  const cross = cross3(sub3(b, a), sub3(c, a));
  const twiceArea = len3(cross);
  return {
    corners: [a, b, c],
    normal: twiceArea > 0 ? scale3(cross, 1 / twiceArea) : [0, 0, 0],
    centroid: scale3(add3(add3(a, b), c), 1 / 3),
    area: twiceArea / 2,
  };
}

const xLogAbs = (u: number): number => (u === 0 ? 0 : u * Math.log(Math.abs(u)) - u);

/** ∫_0^1 ln|w - t v| dt in closed form. */
function logIntegral(w: Vec3, v: Vec3): number {
  const a = dot3(v, v);
  if (a === 0) return Math.log(len3(w));
  const wv = dot3(w, v);
  const cross = cross3(w, v);
  const delta = 4 * dot3(cross, cross);
  if (delta === 0) return 0.5 * Math.log(a) + xLogAbs(1 - wv / a) - xLogAbs(-wv / a);
  const b = -2 * wv;
  const root = Math.sqrt(delta);
  const antiderivative = (t: number): number => {
    const d = sub3(w, scale3(v, t));
    const q = dot3(d, d);
    const logTerm = q > 0 ? (t + b / (2 * a)) * Math.log(q) : 0;
    return logTerm - 2 * t + (root / a) * Math.atan((2 * a * t + b) / root);
  };
  return 0.5 * (antiderivative(1) - antiderivative(0));
}

const gaussLegendre = (f: (s: number) => number, lo: number, hi: number): number => {
  const half = 0.5 * (hi - lo);
  const mid = 0.5 * (hi + lo);
  let sum = 0;
  for (let k = 0; k < NODES.length; k += 1) {
    const node = (NODES[k] ?? 0) * half;
    sum += (WEIGHTS[k] ?? 0) * (f(mid - node) + f(mid + node));
  }
  return sum * half;
};

function adaptive(f: (s: number) => number, lo: number, hi: number, whole: number, tolerance: number, depth: number): number {
  const mid = 0.5 * (lo + hi);
  const left = gaussLegendre(f, lo, mid);
  const right = gaussLegendre(f, mid, hi);
  if (depth <= 0 || Math.abs(left + right - whole) <= tolerance) return left + right;
  return adaptive(f, lo, mid, left, tolerance / 2, depth - 1) + adaptive(f, mid, hi, right, tolerance / 2, depth - 1);
}

/** ∫_0^1 ∫_0^1 ln|(a + s u) - (c + t v)| dt ds. */
function edgePairIntegral(a: Vec3, u: Vec3, c: Vec3, v: Vec3): number {
  const inner = (s: number): number => logIntegral(sub3(add3(a, scale3(u, s)), c), v);
  return adaptive(inner, 0, 1, gaussLegendre(inner, 0, 1), TOLERANCE, MAX_DEPTH);
}

/** True when facet `to` is in front of `from` and vice versa (centroid test of TECHNICAL_SPEC 5.4). */
export const facing = (from: Facet, to: Facet): boolean =>
  dot3(from.normal, sub3(to.centroid, from.centroid)) > 0 && dot3(to.normal, sub3(from.centroid, to.centroid)) > 0;

/** A_i F_ij in the length unit squared (0 for facets that do not face each other). */
export function exchangeArea(from: Facet, to: Facet): number {
  if (!facing(from, to)) return 0;
  let sum = 0;
  for (let a = 0; a < 3; a += 1) {
    const start = from.corners[a] as Vec3;
    const u = sub3(from.corners[(a + 1) % 3] as Vec3, start);
    for (let b = 0; b < 3; b += 1) {
      const origin = to.corners[b] as Vec3;
      const v = sub3(to.corners[(b + 1) % 3] as Vec3, origin);
      const alignment = dot3(u, v);
      if (alignment !== 0) sum += alignment * edgePairIntegral(start, u, origin, v);
    }
  }
  return sum / (2 * Math.PI);
}
