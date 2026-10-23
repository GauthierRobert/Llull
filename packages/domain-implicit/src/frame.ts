/** Coordinate frames of the tape: registers holding x, y, z of a point expressed in a (possibly placed and scaled) local system. */

import type { FieldBuilder } from '@core/geometry/field/build';
import type { Vec3 } from '@core/model/types';
import { applyEulerXYZ, isZeroRotation } from '@lib/eulerRotation';

export interface Frame {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** Stable key of the frame, for memoising node compilation. */
  readonly key: string;
}

export interface Box {
  readonly min: Vec3;
  readonly max: Vec3;
}

export const worldFrame = (b: FieldBuilder): Frame => ({ x: b.x(), y: b.y(), z: b.z(), key: 'w' });

/** Image of the unit axes under an Euler XYZ rotation (columns of the rotation matrix). */
const rotationColumns = (euler: Vec3): [Vec3, Vec3, Vec3] => [
  applyEulerXYZ([1, 0, 0], [0, 0, 0], euler),
  applyEulerXYZ([0, 1, 0], [0, 0, 0], euler),
  applyEulerXYZ([0, 0, 1], [0, 0, 0], euler),
];

/**
 * Frame of a body placed at `position` with Euler `rotation` and uniform `scale` inside `frame`: local = R^T (p - position) / scale, so a
 * shape defined about the local origin appears at `position`.
 */
export function placeFrame(b: FieldBuilder, frame: Frame, position: Vec3, rotation: Vec3, scale: number): Frame {
  const d = [b.shift(frame.x, -position[0]), b.shift(frame.y, -position[1]), b.shift(frame.z, -position[2])] as const;
  const rotated = isZeroRotation(rotation)
    ? d
    : (rotationColumns(rotation).map((column) =>
        b.add(b.add(b.scale(d[0], column[0]), b.scale(d[1], column[1])), b.scale(d[2], column[2])),
      ) as unknown as readonly [number, number, number]);
  const local =
    scale === 1 ? rotated : ([b.scale(rotated[0], 1 / scale), b.scale(rotated[1], 1 / scale), b.scale(rotated[2], 1 / scale)] as const);
  return { x: local[0], y: local[1], z: local[2], key: `${frame.key}>${position.join(',')}|${rotation.join(',')}|${scale}` };
}

/** Axis-aligned box of `box` (local) mapped into the outer frame by scale, Euler rotation and translation. */
export function placeBox(box: Box, position: Vec3, rotation: Vec3, scale: number): Box {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const cx of [box.min[0], box.max[0]])
    for (const cy of [box.min[1], box.max[1]])
      for (const cz of [box.min[2], box.max[2]]) {
        const p = applyEulerXYZ([cx * scale, cy * scale, cz * scale], [0, 0, 0], rotation);
        for (const axis of [0, 1, 2] as const) {
          const value = p[axis] + position[axis];
          min[axis] = Math.min(min[axis], value);
          max[axis] = Math.max(max[axis], value);
        }
      }
  return { min, max };
}

export const growBox = (box: Box, by: number): Box => ({
  min: [box.min[0] - by, box.min[1] - by, box.min[2] - by],
  max: [box.max[0] + by, box.max[1] + by, box.max[2] + by],
});

export const unionBox = (a: Box, b: Box): Box => ({
  min: [Math.min(a.min[0], b.min[0]), Math.min(a.min[1], b.min[1]), Math.min(a.min[2], b.min[2])],
  max: [Math.max(a.max[0], b.max[0]), Math.max(a.max[1], b.max[1]), Math.max(a.max[2], b.max[2])],
});

/** Overlap of two boxes (an empty overlap gives a zero-size box at the closer corner). */
export const intersectBox = (a: Box, b: Box): Box => {
  const min: Vec3 = [Math.max(a.min[0], b.min[0]), Math.max(a.min[1], b.min[1]), Math.max(a.min[2], b.min[2])];
  return {
    min,
    max: [
      Math.max(min[0], Math.min(a.max[0], b.max[0])),
      Math.max(min[1], Math.min(a.max[1], b.max[1])),
      Math.max(min[2], Math.min(a.max[2], b.max[2])),
    ],
  };
};

/** Frame of a point relative to origin with local z along axis (any non-zero vector): local = (d . e1, d . e2, d . axis). */
export function axisFrame(b: FieldBuilder, frame: Frame, origin: Vec3, axis: Vec3): Frame {
  const length = Math.hypot(...axis);
  const w: Vec3 = [axis[0] / length, axis[1] / length, axis[2] / length];
  const helper: Vec3 = Math.abs(w[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const cross = (p: Vec3, q: Vec3): Vec3 => [p[1] * q[2] - p[2] * q[1], p[2] * q[0] - p[0] * q[2], p[0] * q[1] - p[1] * q[0]];
  const e1raw = cross(helper, w);
  const norm = Math.hypot(...e1raw);
  const e1: Vec3 = [e1raw[0] / norm, e1raw[1] / norm, e1raw[2] / norm];
  const e2 = cross(w, e1);
  const d = [b.shift(frame.x, -origin[0]), b.shift(frame.y, -origin[1]), b.shift(frame.z, -origin[2])] as const;
  const along = (e: Vec3): number => b.add(b.add(b.scale(d[0], e[0]), b.scale(d[1], e[1])), b.scale(d[2], e[2]));
  return { x: along(e1), y: along(e2), z: along(w), key: `${frame.key}>axis${origin.join(',')}|${axis.join(',')}` };
}
