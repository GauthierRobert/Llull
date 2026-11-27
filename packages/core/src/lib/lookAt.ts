/**
 * Aim frames for scene objects (light, camera): local -Z is the aim axis, local +Y the up axis (three.js camera convention), in the repo's
 * Euler XYZ convention (`axisRotation.ts`).
 */

import type { Vec3 } from '../model/vectors';
import { applyMat3, eulerFromMat, matFromEulerXYZ, unitAxisOrNull, type Mat3 } from './axisRotation';

const WORLD_UP: Vec3 = [0, 0, 1];
const WORLD_FORWARD: Vec3 = [0, 1, 0];

const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const normalized = (v: Vec3): Vec3 => {
  const length = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / length, v[1] / length, v[2] / length];
};

/**
 * Euler XYZ angles whose local -Z points along `direction` (any non-zero length) with local +Y as close to world +Z as possible (a level
 * horizon); straight up or down uses world +Y as the up hint. `null` for a zero or non-finite direction.
 */
export function lookAtEuler(direction: unknown): Vec3 | null {
  const aim = unitAxisOrNull(direction);
  if (aim === null) return null;
  const back: Vec3 = [-aim[0], -aim[1], -aim[2]];
  const hint = Math.abs(dot(aim, WORLD_UP)) > 0.999999 ? WORLD_FORWARD : WORLD_UP;
  const right = normalized(cross(hint, back));
  const up = cross(back, right);
  const matrix: Mat3 = [right[0], up[0], back[0], right[1], up[1], back[1], right[2], up[2], back[2]];
  const [rx, ry, rz] = eulerFromMat(matrix);
  return [rx + 0, ry + 0, rz + 0];
}

/** Unit world direction of local -Z (the aim of a light or camera) for a stored rotation. */
export function aimDirection(rotation: Vec3): Vec3 {
  const [x, y, z] = applyMat3(matFromEulerXYZ(rotation), [0, 0, -1]);
  return [x, y, z];
}

/** Unit world direction of local +Y (the up of a camera) for a stored rotation. */
export function upDirection(rotation: Vec3): Vec3 {
  const [x, y, z] = applyMat3(matFromEulerXYZ(rotation), [0, 1, 0]);
  return [x, y, z];
}
