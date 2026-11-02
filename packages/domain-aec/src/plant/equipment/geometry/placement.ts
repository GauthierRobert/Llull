/** Shared vector helpers and the placement record of nozzles in the equipment frame (plant 03 EQP §5.4). */

import type { Vec3 } from '@core/model/types';

/** Nozzle geometry in the equipment frame: `base` (inside the wall), flange-face centre `face`, unit outward `direction`. */
export interface NozzlePlacement {
  readonly base: Vec3;
  readonly face: Vec3;
  readonly direction: Vec3;
}

export const rad = (degrees: number): number => (degrees * Math.PI) / 180;
export const point = (x: number, y: number, z: number): Vec3 => [x, y, z];
export const offsetAlong = (from: Vec3, direction: Vec3, distance: number): Vec3 =>
  point(from[0] + direction[0] * distance, from[1] + direction[1] * distance, from[2] + direction[2] * distance);

/** Shell-style placement around an axis along X: station `x`, angle about the axis (north_cw horizontal: 0 = top +Z, 90 = +Y), `start` = base radius. */
export function aroundXAxis(x: number, axisZ: number, orientationDeg: number, start: number, projection: number): NozzlePlacement {
  const angle = rad(orientationDeg);
  const direction = point(0, Math.sin(angle), Math.cos(angle));
  const centre = point(x, 0, axisZ);
  return { base: offsetAlong(centre, direction, start), face: offsetAlong(centre, direction, projection), direction };
}
