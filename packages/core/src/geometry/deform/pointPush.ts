/**
 * Point push (01 DEF §5.5): p goes to p + distance x direction x φ(|p - center| / radius), φ(s) = (1 - s²)³ (`smooth_c2`, C2 at s = 1) or 1 - 3s² + 2s³
 * (`cubic`, C1), zero from s = 1 on.
 * @invariant det J = 1 + distance (direction · ∇φ); min det J = 1 - |distance| max|φ'| / radius, so the push folds the body once |distance| reaches
 *   radius / max|φ'| (smooth_c2: 25√5 radius / 96 = 0.5823 radius; cubic: 2 radius / 3)
 */

import type { DeformLaw } from '../../model/deform';
import type { Vec3 } from '../../model/vectors';

export type PointLaw = Extract<DeformLaw, { kind: 'point' }>;

/** φ(s) and φ'(s) for 0 <= s < 1. */
function profile(law: PointLaw, s: number): { value: number; slope: number } {
  if (law.falloff === 'cubic') return { value: 1 - 3 * s * s + 2 * s * s * s, slope: -6 * s + 6 * s * s };
  const w = 1 - s * s;
  return { value: w * w * w, slope: -6 * s * w * w };
}

const offset = (law: PointLaw, q: Vec3): { d: Vec3; s: number } => {
  const d: Vec3 = [q[0] - law.center[0], q[1] - law.center[1], q[2] - law.center[2]];
  return { d, s: Math.hypot(d[0], d[1], d[2]) / law.radius };
};

/** The image of local point `q`. */
export function pointMap(law: PointLaw, q: Vec3): Vec3 {
  const { s } = offset(law, q);
  if (!(s < 1)) return q;
  const push = law.distance * profile(law, s).value;
  return [q[0] + push * law.direction[0], q[1] + push * law.direction[1], q[2] + push * law.direction[2]];
}

/** det J of the push at local point `q`. */
export function pointDeterminant(law: PointLaw, q: Vec3): number {
  const { d, s } = offset(law, q);
  if (!(s < 1) || s === 0) return 1;
  const length = s * law.radius;
  const along = (d[0] * law.direction[0] + d[1] * law.direction[1] + d[2] * law.direction[2]) / length;
  return 1 + law.distance * profile(law, s).slope * (along / law.radius);
}

/** max |φ'(s)| over s in [0, 1]. */
export function maxSlope(law: PointLaw): number {
  return law.falloff === 'cubic' ? 1.5 : 96 / (25 * Math.sqrt(5));
}

/** The largest |distance| the push may have before it folds the body: radius / max|φ'|. */
export function foldLimit(law: PointLaw): number {
  return law.radius / maxSlope(law);
}

/** Range of det J over all space: 1 -/+ |distance| max|φ'| / radius. */
export function determinantRange(law: PointLaw): { min: number; max: number } {
  const swing = (Math.abs(law.distance) * maxSlope(law)) / law.radius;
  return { min: 1 - swing, max: 1 + swing };
}
