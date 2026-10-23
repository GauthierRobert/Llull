/**
 * Cross-boundary data of a patch edge (02 SRF): at a point of a boundary edge, the unit direction in the tangent plane that leaves the patch
 * perpendicular to the edge, the surface normal and the normal curvature along that direction. These are the quantities a neighbouring
 * surface must reproduce to continue the patch with G1 (position + tangent plane) or G2 (+ normal curvature across the edge).
 */

import type { Vec3 } from '../../model/vectors';
import { cross3, dot3, len3, scale3 } from '../vec3';
import { closestOnCurve } from './closest';
import { evaluateCurve } from './evaluate';
import { isoCurve, surfaceDomain } from './surface';
import { normalCurvature, surfaceSample } from './surfaceCurvature';
import type { NurbsSurfaceData } from './surfaceTypes';
import type { NurbsCurveData } from './types';

export type PatchSide = 'u0' | 'u1' | 'v0' | 'v1';

export const PATCH_SIDES: ReadonlyArray<PatchSide> = ['u0', 'u1', 'v0', 'v1'];

export interface CrossFrame {
  readonly point: Vec3;
  /** Unit vector in the tangent plane, perpendicular to the edge, pointing out of the patch. */
  readonly across: Vec3;
  /** Unit surface normal (its sign fixes the sign of `curvature`). */
  readonly normal: Vec3;
  /** Normal curvature along `across` (1/length, signed about `normal`). */
  readonly curvature: number;
  /** True where the patch is singular (a pole or collapsed edge): no frame exists there. */
  readonly degenerate: boolean;
}

/** The edge of `surface` on `side` as a curve in 3D, with its parameter interval and the (u, v) of its point at parameter t. */
export function sideEdge(
  surface: NurbsSurfaceData,
  side: PatchSide,
): { curve: NurbsCurveData; interval: readonly [number, number]; at: (t: number) => readonly [number, number] } {
  const [[uMin, uMax], [vMin, vMax]] = surfaceDomain(surface);
  switch (side) {
    case 'u0':
      return { curve: isoCurve(surface, 'u', uMin), interval: [vMin, vMax], at: (t) => [uMin, t] };
    case 'u1':
      return { curve: isoCurve(surface, 'u', uMax), interval: [vMin, vMax], at: (t) => [uMax, t] };
    case 'v0':
      return { curve: isoCurve(surface, 'v', vMin), interval: [uMin, uMax], at: (t) => [t, vMin] };
    case 'v1':
      return { curve: isoCurve(surface, 'v', vMax), interval: [uMin, uMax], at: (t) => [t, vMax] };
  }
}

/** The (a, b) with w ~ a S_u + b S_v: the tangent-plane coefficients of `w`. */
function coefficients(su: Vec3, sv: Vec3, e: number, f: number, g: number, w: Vec3): [number, number] {
  const [p, q] = [dot3(w, su), dot3(w, sv)];
  const determinant = e * g - f * f;
  return [(g * p - f * q) / determinant, (e * q - f * p) / determinant];
}

/** Cross frame of the edge `side` of `surface` at edge parameter `t` (a value of the edge curve's own parameter). */
export function crossFrameAt(surface: NurbsSurfaceData, side: PatchSide, t: number): CrossFrame {
  const [u, v] = sideEdge(surface, side).at(t);
  const sample = surfaceSample(surface, u, v);
  if (sample.degenerate) return { point: sample.point, across: [0, 0, 0], normal: [0, 0, 0], curvature: 0, degenerate: true };
  const [along, outward] = side.startsWith('u')
    ? [sample.sv, side.endsWith('1') ? sample.su : scale3(sample.su, -1)]
    : [sample.su, side.endsWith('1') ? sample.sv : scale3(sample.sv, -1)];
  let across = cross3(sample.normal, along);
  if (dot3(across, outward) < 0) across = scale3(across, -1);
  across = scale3(across, 1 / (len3(across) || 1));
  const [a, b] = coefficients(sample.su, sample.sv, sample.e, sample.f, sample.g, across);
  return { point: sample.point, across, normal: sample.normal, curvature: normalCurvature(sample, a, b), degenerate: false };
}

/** The side of `surface` whose edge the curve lies on (mean distance of nine curve points to the edge), if within `tolerance`. */
export function matchingSide(surface: NurbsSurfaceData, curve: NurbsCurveData, tolerance: number): PatchSide | null {
  const [first, last] = [curve.knots[0] as number, curve.knots[curve.knots.length - 1] as number];
  let best: { side: PatchSide; distance: number } | null = null;
  for (const side of PATCH_SIDES) {
    const edge = sideEdge(surface, side);
    let worst = 0;
    for (let k = 0; k <= 8; k++)
      worst = Math.max(worst, closestOnCurve(edge.curve, evaluateCurve(curve, first + ((last - first) * k) / 8)).distance);
    if (best === null || worst < best.distance) best = { side, distance: worst };
  }
  return best !== null && best.distance <= tolerance ? best.side : null;
}
