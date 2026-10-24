/**
 * Eccentric reducers (02 RTE V1): the flat side and the offset of the centreline.
 *
 * The outer surfaces of the two pipes line up on the FLAT side, so the axis of the smaller pipe lies `e = (OD big - OD small) / 2` toward the flat side
 * of the axis of the bigger one. In the flow direction a reducer (big -> small) moves the axis by `+e x flat`, an expander (small -> big) by `-e x flat`.
 * Flat on top of a horizontal pipe is `+Z`, flat on bottom `-Z`. The offset is perpendicular to the pipe axis.
 * @invariant a reducer's offset D must be taken up by the run: the sum of D over a leg is parallel to the next leg (which absorbs it by its length) and
 *   zero on the last leg, so the stored points of intersection stay the geometry of the run
 */

import type { Vec3 } from '@core/model/vectors';
import { dot3, len3, scale3, sub3 } from '@lib/vec3';

/** Smallest component of the flat direction perpendicular to the pipe axis for the direction to be usable. */
const MIN_PERPENDICULAR = 1e-6;

const unit = (v: Vec3): Vec3 => {
  const length = len3(v);
  return length > 0 ? scale3(v, 1 / length) : [0, 0, 0];
};

/** The flat direction projected perpendicular to the unit pipe axis `u` and normalised; null when it lies along the pipe (no flat side). */
export function flatPerpendicular(flat: Vec3, u: Vec3): Vec3 | null {
  const rest = sub3(unit(flat), scale3(u, dot3(unit(flat), u)));
  return len3(rest) > MIN_PERPENDICULAR ? unit(rest) : null;
}

/**
 * The flat direction an eccentric reducer on a pipe of direction `u` gets from `flat` ("top" = +Z, "bottom" = -Z, projected perpendicular to a sloped pipe)
 * or from an explicit `direction` (any vector not along the pipe).
 * @failure neither or both given, a zero or axial direction, or top / bottom on a vertical pipe -> a message
 */
export function resolveFlat(flat: 'top' | 'bottom' | undefined, direction: Vec3 | undefined, u: Vec3): Vec3 | string {
  if ((flat === undefined) === (direction === undefined))
    return 'an eccentric reducer needs exactly one of flat ("top" | "bottom") and flatDirection [dx, dy, dz]: the flat side is a design decision';
  const wanted: Vec3 = direction ?? (flat === 'top' ? [0, 0, 1] : [0, 0, -1]);
  const perpendicular = flatPerpendicular(wanted, u);
  if (perpendicular !== null) return perpendicular;
  return direction === undefined
    ? `"${flat}" is meaningless on a vertical pipe: give flatDirection (the side the flat is on)`
    : 'flatDirection is zero or along the pipe: it must point to a side of the pipe';
}

/** `top`, `bottom` or `side` for the flat direction of a reducer (by the vertical component of the direction). */
export const flatLabel = (flat: Vec3): 'top' | 'bottom' | 'side' => (flat[2] > 0.5 ? 'top' : flat[2] < -0.5 ? 'bottom' : 'side');

/** Offset of the downstream axis from the upstream one (see the module comment): the unit `flat` direction times the radius difference, signed by the flow. */
export function eccentricOffset(flat: Vec3, odIn: number, odOut: number): Vec3 {
  return scale3(flat, (odIn - odOut) / 2);
}
