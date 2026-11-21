/** The frame an equipment nozzle load is stated in (07 PST §5.9): z along the nozzle axis pointing away from the equipment (03 EQP port direction). */

import type { Vec3 } from './nozzleLimits';

export interface NozzleFrame {
  readonly x: Vec3;
  readonly y: Vec3;
  readonly z: Vec3;
}

const EPSILON = 1e-9;

const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a: Vec3): Vec3 | null => {
  const length = Math.hypot(a[0], a[1], a[2]);
  return length > EPSILON ? [a[0] / length, a[1] / length, a[2] / length] : null;
};
/** The part of `a` perpendicular to the unit vector `n`, as a unit vector (null when `a` is along `n`). */
const perpendicular = (a: Vec3, n: Vec3): Vec3 | null => {
  const along = dot(a, n);
  return unit([a[0] - along * n[0], a[1] - along * n[1], a[2] - along * n[2]]);
};

/**
 * Right-handed frame of a nozzle with axis `direction`. Without `frameX`: y is world +Z projected on the plane normal to the axis (world +Y for a vertical nozzle), x = y cross z.
 * With `frameX` (for example the pump shaft): x is that vector projected on the plane normal to the axis, y = z cross x. Null when the axis is zero or `frameX` is along it.
 */
export function nozzleFrame(direction: Vec3, frameX?: Vec3): NozzleFrame | null {
  const z = unit(direction);
  if (z === null) return null;
  if (frameX !== undefined) {
    const x = perpendicular(frameX, z);
    return x === null ? null : { x, y: cross(z, x), z };
  }
  const y = perpendicular([0, 0, 1], z) ?? [0, 1, 0];
  return { x: cross(y, z), y, z };
}

/** Components of a global vector in the frame. */
export const toFrame = (frame: NozzleFrame, vector: Vec3): Vec3 => [dot(vector, frame.x), dot(vector, frame.y), dot(vector, frame.z)];
