/** Statically determinate 3-2-1 support of a released part: which dofs of which point are fixed (CalculiX dof numbers 1-3). */

import type { Vec3 } from '@core/model/vectors';
import { cross3, len3, sub3 } from '@lib/vec3';

/** Dofs fixed at P1, P2, P3 (1 = ux, 2 = uy, 3 = uz): three, two and one. */
export type Support321Dofs = readonly [readonly number[], readonly number[], readonly number[]];

/** Relative size of |P1P2 x P1P3| below which the three points count as collinear. */
const COLLINEAR = 1e-9;

/** Index (0-2) of the component of `v` with the largest magnitude (the first on ties). */
const dominantAxis = (v: Vec3): 0 | 1 | 2 => {
  const [x, y, z] = [Math.abs(v[0]), Math.abs(v[1]), Math.abs(v[2])];
  return x >= y && x >= z ? 0 : y >= z ? 1 : 2;
};

/**
 * The 3-2-1 dofs of three points: P1 fixed in x, y, z (no translation); P2 in the two axes orthogonal to the dominant axis of P1P2 (no rotation about
 * an axis through P1 other than the line P1P2: the projections of two axes other than the dominant one on the plane orthogonal to P1P2 are independent
 * because P1P2 has a non-zero component along the dominant axis); P3 in the axis the rotation about P1P2 moves it most along (that rotation moves P3 by
 * P1P2/|P1P2| x P1P3, non-zero unless the points are collinear). Together six independent rigid-body constraints: a statically determinate support.
 * @failure coincident or collinear points, non-finite coordinates -> a reason string
 */
export function support321(points: readonly [Vec3, Vec3, Vec3]): Support321Dofs | string {
  const [p1, p2, p3] = points;
  if (!points.every((point) => point.every(Number.isFinite))) return 'the three points must be finite';
  const d = sub3(p2, p1);
  const r = sub3(p3, p1);
  const dLength = len3(d);
  if (!(dLength > 0)) return 'points 1 and 2 coincide';
  const swirl = cross3([d[0] / dLength, d[1] / dLength, d[2] / dLength], r);
  if (!(len3(swirl) > COLLINEAR * Math.max(len3(r), dLength))) return 'the three points are collinear';
  const dominant = dominantAxis(d);
  return [[1, 2, 3], [0, 1, 2].filter((axis) => axis !== dominant).map((axis) => axis + 1), [dominantAxis(swirl) + 1]];
}
