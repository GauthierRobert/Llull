/**
 * @layer lib
 * @pure
 */

import type { Vec3 } from '../model/types';

/** The vector of an axis param: 'x' | 'y' | 'z' map to unit vectors; a Vec3 is returned as given. */
export function axisVector(axis: 'x' | 'y' | 'z' | Vec3): Vec3 {
  if (axis === 'x') return [1, 0, 0];
  if (axis === 'y') return [0, 1, 0];
  if (axis === 'z') return [0, 0, 1];
  return axis;
}

/** True for a named axis ('x' | 'y' | 'z') or a 3-array of finite numbers. */
export function isValidAxis(v: unknown): v is 'x' | 'y' | 'z' | Vec3 {
  if (v === 'x' || v === 'y' || v === 'z') return true;
  if (!Array.isArray(v) || v.length !== 3) return false;
  return (v as unknown[]).every((c) => typeof c === 'number' && Number.isFinite(c));
}
