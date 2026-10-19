/** Differential geometry of a NURBS curve (SRF §5.6): curvature, torsion, d(curvature)/ds, arc length, planarity. */

import type { Vec3 } from '../../model/vectors';
import { cross3, distance3, dot3, len3, normalize3, scale3, sub3 } from '../vec3';
import { curveDerivatives } from './evaluate';
import { integrateCurve } from './integrate';
import type { NurbsCurveData } from './types';

export interface CurvatureSample {
  readonly point: Vec3;
  readonly tangent: Vec3;
  /** Principal normal (toward the centre of curvature); the zero vector where the curvature vanishes. */
  readonly normal: Vec3;
  /** |C' x C''| / |C'|^3 >= 0. */
  readonly curvature: number;
  /** Signed curvature about `planeNormal` (planar curves), else null. */
  readonly signedCurvature: number | null;
  readonly dCurvatureDs: number;
  readonly torsion: number;
  /** True where C' = 0: the other fields are zero and the sample must not be over-read. */
  readonly degenerate: boolean;
}

const EPSILON = 1e-12;

/**
 * Unit normal of the plane holding every pole (sign fixed so the first non-zero of z, y, x is positive), or null when the poles are not
 * coplanar within 1e-9 of the pole extent (or are collinear).
 */
export function planeNormalOf(curve: NurbsCurveData): Vec3 | null {
  const origin = curve.poles[0] as Vec3;
  const extent = Math.max(...curve.poles.map((pole) => distance3(pole, origin)));
  if (extent === 0) return null;
  let normal: Vec3 = [0, 0, 0];
  let best = 0;
  for (let i = 1; i < curve.poles.length; i++)
    for (let j = i + 1; j < curve.poles.length; j++) {
      const candidate = cross3(sub3(curve.poles[i] as Vec3, origin), sub3(curve.poles[j] as Vec3, origin));
      if (len3(candidate) > best) {
        best = len3(candidate);
        normal = candidate;
      }
    }
  if (best <= 1e-9 * extent * extent) return null;
  const unit = normalize3(normal);
  if (curve.poles.some((pole) => Math.abs(dot3(sub3(pole, origin), unit)) > 1e-9 * extent)) return null;
  const lead = [unit[2], unit[1], unit[0]].find((component) => Math.abs(component) > 1e-9) ?? 1;
  return lead < 0 ? scale3(unit, -1) : unit;
}

/**
 * Curvature measures at parameter `u`. With `planeNormal` the signed forms (kappa = (C' x C'') . n / |C'|^3) are used so that dkappa/ds is
 * exact through inflections (y = x^3 at 0 gives 6); without it, dkappa/ds at an exact inflection falls back to |C' x C'''| / |C'|^4.
 */
export function curvatureAt(curve: NurbsCurveData, u: number, planeNormal: Vec3 | null): CurvatureSample {
  const [c0, c1, c2, c3] = curveDerivatives(curve, u, 3) as [Vec3, Vec3, Vec3, Vec3];
  const speed = len3(c1);
  if (speed < EPSILON)
    return {
      point: c0,
      tangent: [0, 0, 0],
      normal: [0, 0, 0],
      curvature: 0,
      signedCurvature: null,
      dCurvatureDs: 0,
      torsion: 0,
      degenerate: true,
    };
  const a = cross3(c1, c2);
  const b = cross3(c1, c3);
  const aLength = len3(a);
  const tangent = scale3(c1, 1 / speed);
  const curvature = aLength / speed ** 3;
  const normal = aLength < EPSILON * speed ** 3 ? ([0, 0, 0] as Vec3) : normalize3(cross3(a, c1));
  const speedDot = dot3(c1, c2);
  let dCurvatureDs: number;
  let signedCurvature: number | null = null;
  if (planeNormal !== null) {
    signedCurvature = dot3(a, planeNormal) / speed ** 3;
    dCurvatureDs = (dot3(b, planeNormal) / speed ** 3 - (3 * dot3(a, planeNormal) * speedDot) / speed ** 5) / speed;
  } else if (aLength < EPSILON * speed ** 3) {
    dCurvatureDs = len3(b) / speed ** 4;
  } else {
    dCurvatureDs = (dot3(a, b) / (aLength * speed ** 3) - (3 * aLength * speedDot) / speed ** 5) / speed;
  }
  const torsion = aLength < EPSILON * speed ** 3 ? 0 : dot3(a, c3) / (aLength * aLength);
  return { point: c0, tangent, normal, curvature, signedCurvature, dCurvatureDs, torsion, degenerate: false };
}

/** Arc length of the curve between parameters `from` and `to` (either order; composite Gauss-Legendre, see `integrateCurve`). */
export function curveLength(curve: NurbsCurveData, from: number, to: number): number {
  return Math.abs(integrateCurve(curve, from, to, (_point, derivative) => len3(derivative)));
}
