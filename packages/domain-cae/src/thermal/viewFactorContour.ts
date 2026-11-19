/**
 * Diffuse view factors between planar triangles by contour integration (PHY-03 TR-THM-20, TECHNICAL_SPEC 5.4):
 * F_ij = 1/(2 pi A_i) ∮∮ ln(r) dl_i · dl_j with both contours counter-clockwise about their own (emitting-side) normal.
 * Each edge pair is integrated exactly along one edge (closed-form antiderivative of ln r, including collinear edges) and with
 * 8-point Gauss-Legendre panels, adaptively bisected, along the other (touching edges make the outer integrand non-smooth).
 * `reciprocalExchangeArea` is the pair value of the `reciprocal` integration (PERF1 §5 row 4): one panel when the facets are well separated.
 */

import type { Vec3 } from '@core/model/vectors';
import { add3, cross3, dot3, len3, scale3, sub3 } from '@lib/vec3';

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
/**
 * Well-separated criterion of the `reciprocal` integration: centroid distance >= SEPARATION x (r_i + r_j), r = the largest
 * centroid-to-corner distance of a facet. The facets are then at least (SEPARATION - 1)(r_i + r_j) apart and no edge is longer than 2 r,
 * so, mapped to [-1, 1], the outer integrand of an edge pair has no singularity within D = SEPARATION - 1 = 4 of the interval. Error
 * bound of ONE 8-point Gauss-Legendre panel (Trefethen 2008, Thm 4.5, on the Bernstein ellipse at 3/4 of that distance, rho = 3 + sqrt(10)
 * = 6.2): 64 M / (15 (rho^2 - 1) rho^16) / 2 = 1.33e-14 M, M = the deviation of the integrand from a constant there (<= ln 4 + ln 1.5 ~ 2),
 * so about 2.7e-14 absolute per edge-pair integral, the order of the adaptive rule's 1e-13. The contour sum cancels the common ln r of a
 * far pair, so its A_i F_ij is relatively less exact than that (measured up to 7e-10 relative on two slivers just past the threshold; both rules share this rounding), but such pairs carry little of a surface's
 * exchange. Measured: < 5e-14 per edge-pair integral just beyond the threshold; matrix entries of meshed cube cavities within 7.3e-14
 * relative of `full`, row sums 1.9e-14 (3 072 facets); tested at 1e-12 / 2e-13 (tests/unit/physics/thermal/viewFactorIntegration.test.ts,
 * llull-geomq `reciprocal_tests.rs`).
 */
const SEPARATION = 5;

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

type EdgePairRule = (a: Vec3, u: Vec3, c: Vec3, v: Vec3) => number;

/** ∫_0^1 ∫_0^1 ln|(a + s u) - (c + t v)| dt ds. */
const edgePairIntegral: EdgePairRule = (a, u, c, v) => {
  const inner = (s: number): number => logIntegral(sub3(add3(a, scale3(u, s)), c), v);
  return adaptive(inner, 0, 1, gaussLegendre(inner, 0, 1), TOLERANCE, MAX_DEPTH);
};

/** The same integral by ONE 8-point panel, no bisection: for well-separated facets only. */
const edgePairPanel: EdgePairRule = (a, u, c, v) => gaussLegendre((s) => logIntegral(sub3(add3(a, scale3(u, s)), c), v), 0, 1);

/** True when facet `to` is in front of `from` and vice versa (centroid test of TECHNICAL_SPEC 5.4). */
export const facing = (from: Facet, to: Facet): boolean =>
  dot3(from.normal, sub3(to.centroid, from.centroid)) > 0 && dot3(to.normal, sub3(from.centroid, to.centroid)) > 0;

/** A_i F_ij of two facets that face each other, each edge pair by `rule`. */
function facingExchangeArea(from: Facet, to: Facet, rule: EdgePairRule): number {
  let sum = 0;
  for (let a = 0; a < 3; a += 1) {
    const start = from.corners[a] as Vec3;
    const u = sub3(from.corners[(a + 1) % 3] as Vec3, start);
    for (let b = 0; b < 3; b += 1) {
      const origin = to.corners[b] as Vec3;
      const v = sub3(to.corners[(b + 1) % 3] as Vec3, origin);
      const alignment = dot3(u, v);
      if (alignment !== 0) sum += alignment * rule(start, u, origin, v);
    }
  }
  return sum / (2 * Math.PI);
}

/** A_i F_ij in the length unit squared (0 for facets that do not face each other). */
export function exchangeArea(from: Facet, to: Facet): number {
  return facing(from, to) ? facingExchangeArea(from, to, edgePairIntegral) : 0;
}

/** The largest centroid-to-corner distance of a facet. */
function radius(facet: Facet): number {
  let largest = 0;
  for (const corner of facet.corners) {
    const distance = len3(sub3(corner, facet.centroid));
    if (distance > largest) largest = distance;
  }
  return largest;
}

/**
 * A_i F_ij = A_j F_ji of two FACING facets for the `reciprocal` integration: integrated once (contour of `from` outside), by one panel
 * per edge pair when the facets are well separated (`SEPARATION`), else by the adaptive rule of `exchangeArea`.
 */
export function reciprocalExchangeArea(from: Facet, to: Facet): number {
  const reach = SEPARATION * (radius(from) + radius(to));
  const between = sub3(to.centroid, from.centroid);
  return facingExchangeArea(from, to, dot3(between, between) >= reach * reach ? edgePairPanel : edgePairIntegral);
}
