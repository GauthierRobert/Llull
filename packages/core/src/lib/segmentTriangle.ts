/** Segment-triangle intersection (Moller-Trumbore), used by the view-factor obstruction test. */

import type { Vec3 } from '../model/vectors';
import { cross3, dot3, sub3 } from './vec3';

const EPSILON = 1e-12;
const END_MARGIN = 1e-9;

/** True when the open segment from `start` to `end` crosses the interior of triangle `corners` (grazing and end contacts do not count). */
export function segmentHitsTriangle(start: Vec3, end: Vec3, corners: readonly [Vec3, Vec3, Vec3]): boolean {
  const [a, b, c] = corners;
  const direction = sub3(end, start);
  const edge1 = sub3(b, a);
  const edge2 = sub3(c, a);
  const p = cross3(direction, edge2);
  const determinant = dot3(edge1, p);
  if (Math.abs(determinant) < EPSILON * dot3(direction, direction) ** 0.5 * dot3(edge1, edge1) ** 0.5) return false;
  const offset = sub3(start, a);
  const u = dot3(offset, p) / determinant;
  if (u <= 0 || u >= 1) return false;
  const q = cross3(offset, edge1);
  const v = dot3(direction, q) / determinant;
  if (v <= 0 || u + v >= 1) return false;
  const t = dot3(edge2, q) / determinant;
  return t > END_MARGIN && t < 1 - END_MARGIN;
}
