/** Deformation frame (01 DEF §5.1): z = axis, x = reference projected perpendicular to the axis, y = z × x; local coordinates measured from `origin`. */

import type { DeformFrame } from '../../model/deform';
import type { Vec3 } from '../../model/vectors';
import { add3, cross3, dot3, len3, scale3, sub3 } from '../../lib/vec3';

/** Smallest sine of the angle between axis and reference accepted as a frame. */
const PARALLEL_LIMIT = 1e-9;

export interface LocalFrame {
  readonly origin: Vec3;
  readonly x: Vec3;
  readonly y: Vec3;
  readonly z: Vec3;
}

/**
 * The orthonormal frame of `frame`.
 * @failure axis of zero length, non-finite components, or reference parallel to the axis -> null (DEF_FRAME_DEGENERATE)
 */
export function resolveFrame(frame: DeformFrame): LocalFrame | null {
  const all = [...frame.origin, ...frame.axis, ...frame.reference];
  if (!all.every(Number.isFinite)) return null;
  const axisLength = len3(frame.axis);
  const referenceLength = len3(frame.reference);
  if (axisLength === 0 || referenceLength === 0) return null;
  const z = scale3(frame.axis, 1 / axisLength);
  const across = sub3(frame.reference, scale3(z, dot3(frame.reference, z)));
  const acrossLength = len3(across);
  if (acrossLength / referenceLength < PARALLEL_LIMIT) return null;
  const x = scale3(across, 1 / acrossLength);
  return { origin: frame.origin, x, y: cross3(z, x), z };
}

export function toLocal(frame: LocalFrame, point: Vec3): Vec3 {
  const d = sub3(point, frame.origin);
  return [dot3(d, frame.x), dot3(d, frame.y), dot3(d, frame.z)];
}

export function toWorld(frame: LocalFrame, local: Vec3): Vec3 {
  return add3(frame.origin, add3(add3(scale3(frame.x, local[0]), scale3(frame.y, local[1])), scale3(frame.z, local[2])));
}
