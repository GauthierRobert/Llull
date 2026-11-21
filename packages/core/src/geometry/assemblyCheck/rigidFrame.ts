/**
 * Rigid placement of an assembly instance (unit scale): the key of the symmetry reduction and the pair cache (TR-ASC-09 / 10).
 * Two instance pairs of the same component with the same relative placement give the same key, so one evaluation serves both.
 * @invariant a frame exists only for a unit-scale instance (relative distances and volumes are then those of the world)
 * @invariant keys are quantized (translation 1e-6, rotation 1e-9): numerically equal placements share a key, a straddled rounding only misses a hit
 */

import type { InstanceEntity, Vec3 } from '../../model/types';
import { instanceToWorld } from '../instanceTransform';
import { ORIGIN } from '../../lib/vec3';

type Mat3 = readonly [number, number, number, number, number, number, number, number, number];

/** `x' = rotation x + translation`; rotation is row-major. */
export interface RigidFrame {
  readonly rotation: Mat3;
  readonly translation: Vec3;
}

const UNIT: Vec3 = [1, 1, 1];
const TRANSLATION_STEP = 1e6;
const ROTATION_STEP = 1e9;

/** The frame of `instance`, or null when it is scaled (not rigid). */
export function frameOfInstance(instance: InstanceEntity): RigidFrame | null {
  const scale = instance.scale ?? UNIT;
  if (scale[0] !== 1 || scale[1] !== 1 || scale[2] !== 1) return null;
  const toWorld = instanceToWorld(UNIT, instance.rotation, instance.position);
  const origin = toWorld(ORIGIN);
  const [ex, ey, ez] = [toWorld([1, 0, 0]), toWorld([0, 1, 0]), toWorld([0, 0, 1])];
  const column = (axis: 0 | 1 | 2): readonly [number, number, number] => [
    [ex, ey, ez][axis]?.[0] ?? 0,
    [ex, ey, ez][axis]?.[1] ?? 0,
    [ex, ey, ez][axis]?.[2] ?? 0,
  ];
  const [cx, cy, cz] = [column(0), column(1), column(2)];
  const rotation: Mat3 = [
    cx[0] - origin[0],
    cy[0] - origin[0],
    cz[0] - origin[0],
    cx[1] - origin[1],
    cy[1] - origin[1],
    cz[1] - origin[1],
    cx[2] - origin[2],
    cy[2] - origin[2],
    cz[2] - origin[2],
  ];
  return { rotation, translation: origin };
}

/** Local point -> world. */
export function frameApply(frame: RigidFrame, point: Vec3): Vec3 {
  const [r, t] = [frame.rotation, frame.translation];
  return [
    (r[0] ?? 0) * point[0] + (r[1] ?? 0) * point[1] + (r[2] ?? 0) * point[2] + t[0],
    (r[3] ?? 0) * point[0] + (r[4] ?? 0) * point[1] + (r[5] ?? 0) * point[2] + t[1],
    (r[6] ?? 0) * point[0] + (r[7] ?? 0) * point[1] + (r[8] ?? 0) * point[2] + t[2],
  ];
}

/** World point -> local (rotation is orthonormal, so the inverse is the transpose). */
export function frameInvert(frame: RigidFrame, point: Vec3): Vec3 {
  const [r, t] = [frame.rotation, frame.translation];
  const d: Vec3 = [point[0] - t[0], point[1] - t[1], point[2] - t[2]];
  return [
    (r[0] ?? 0) * d[0] + (r[3] ?? 0) * d[1] + (r[6] ?? 0) * d[2],
    (r[1] ?? 0) * d[0] + (r[4] ?? 0) * d[1] + (r[7] ?? 0) * d[2],
    (r[2] ?? 0) * d[0] + (r[5] ?? 0) * d[1] + (r[8] ?? 0) * d[2],
  ];
}

const quantize = (value: number, step: number): number => Math.round(value * step) / step || 0;

/** Quantized placement of `b` in the frame of `a` (`a^-1 b`), as a key fragment. */
export function relativeKey(a: RigidFrame, b: RigidFrame): string {
  const [ra, rb] = [a.rotation, b.rotation];
  const linear: number[] = [];
  for (let row = 0; row < 3; row++)
    for (let col = 0; col < 3; col++)
      linear.push(
        quantize(
          (ra[row] ?? 0) * (rb[col] ?? 0) + (ra[3 + row] ?? 0) * (rb[3 + col] ?? 0) + (ra[6 + row] ?? 0) * (rb[6 + col] ?? 0),
          ROTATION_STEP,
        ),
      );
  const shift = frameInvert(a, b.translation);
  return `${linear.join(',')};${shift.map((v) => quantize(v, TRANSLATION_STEP)).join(',')}`;
}
