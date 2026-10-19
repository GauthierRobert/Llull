/** Conic arcs as rational quadratic Béziers (SRF §5.4): Liming's shoulder parameter rho = w / (1 + w). */

import type { Vec3 } from '../../model/vectors';
import { add3, cross3, distance3, dot3, len3, lerp3, scale3, sub3 } from '../vec3';
import type { NurbsCurveData } from './types';

/** Weight of the apex pole for shoulder parameter `rho` in (0, 1): w = rho / (1 - rho). */
export const conicWeight = (rho: number): number => rho / (1 - rho);

/** Shoulder parameter of a rational quadratic with apex weight `w`. */
export const conicRho = (weight: number): number => weight / (1 + weight);

/** Conic through `start` and `end` with tangent-intersection `apex`; the curve passes `rho` of the way from the chord midpoint to the apex. */
export function conicCurve(start: Vec3, apex: Vec3, end: Vec3, rho: number): NurbsCurveData {
  return { degree: 2, poles: [start, apex, end], weights: [1, conicWeight(rho), 1], knots: [0, 1], multiplicities: [3, 3] };
}

/** True when `start`, `apex`, `end` are (numerically) collinear: the triangle has no area relative to its edges. */
export function isCollinear(start: Vec3, apex: Vec3, end: Vec3): boolean {
  const a = sub3(apex, start);
  const b = sub3(end, start);
  return len3(cross3(a, b)) <= 1e-9 * Math.max(len3(a) * len3(b), 1e-300);
}

/** The point where the tangent lines at `start` and `end` meet (closest point between them), or null when they are parallel or skew by more than 1e-6 of the chord. */
export function tangentApex(start: Vec3, startTangent: Vec3, end: Vec3, endTangent: Vec3): Vec3 | null {
  const w = sub3(start, end);
  const a = dot3(startTangent, startTangent);
  const b = dot3(startTangent, endTangent);
  const c = dot3(endTangent, endTangent);
  const d = dot3(startTangent, w);
  const e = dot3(endTangent, w);
  const denominator = a * c - b * b;
  if (Math.abs(denominator) <= 1e-12 * a * c) return null;
  const s = (b * e - c * d) / denominator;
  const t = (a * e - b * d) / denominator;
  const onStart = add3(start, scale3(startTangent, s));
  const onEnd = add3(end, scale3(endTangent, t));
  if (distance3(onStart, onEnd) > 1e-6 * Math.max(distance3(start, end), 1e-300)) return null;
  return lerp3(onStart, onEnd, 0.5);
}

/** `rho` for a conic through `shoulder` (on the chord-midpoint -> apex line): |shoulder - M| / |apex - M| signed along the line; null when off the line. */
export function rhoFromShoulder(start: Vec3, apex: Vec3, end: Vec3, shoulder: Vec3): number | null {
  const midpoint = lerp3(start, end, 0.5);
  const axis = sub3(apex, midpoint);
  const along = sub3(shoulder, midpoint);
  const lengthSquared = dot3(axis, axis);
  if (lengthSquared === 0) return null;
  const rho = dot3(along, axis) / lengthSquared;
  const residual = len3(sub3(along, scale3(axis, rho)));
  return residual <= 1e-6 * Math.sqrt(lengthSquared) ? rho : null;
}
