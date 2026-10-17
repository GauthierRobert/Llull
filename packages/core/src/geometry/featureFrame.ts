/** Face frames of manufacturing features (07 FTR): local (u, v) on a face plane <-> world, and the Euler rotation that carries a tool into it. */

import type { FeatureFrame } from '../model/features';
import type { Vec2, Vec3 } from '../model/types';
import { eulerFromMat } from '../lib/axisRotation';
import { add3, cross3, dot3, normalize3, scale3, sub3 } from '../lib/vec3';

/** Local y axis of a frame: normal x xDir. */
export const frameYDir = (frame: FeatureFrame): Vec3 => cross3(frame.normal, frame.xDir);

/** World point of local `[u, v]` at `depth` below the face plane (negative = above it). */
export function frameToWorld(frame: FeatureFrame, [u, v]: Vec2, depth = 0): Vec3 {
  const planar = add3(add3(frame.origin, scale3(frame.xDir, u)), scale3(frameYDir(frame), v));
  return sub3(planar, scale3(frame.normal, depth));
}

/** Local `[u, v]` of the world point's projection on the face plane. */
export function worldToFrame(frame: FeatureFrame, point: Vec3): Vec2 {
  const relative = sub3(point, frame.origin);
  return [dot3(relative, frame.xDir), dot3(relative, frameYDir(frame))];
}

/** Signed distance of `point` above the face plane (along the outward normal). */
export const heightAbove = (frame: FeatureFrame, point: Vec3): number => dot3(sub3(point, frame.origin), frame.normal);

/** Euler XYZ rotation taking local x, y, z onto xDir, yDir, normal. */
export function frameEuler(frame: FeatureFrame): Vec3 {
  const [x, y, n] = [frame.xDir, frameYDir(frame), frame.normal];
  return eulerFromMat([x[0], y[0], n[0], x[1], y[1], n[1], x[2], y[2], n[2]]);
}

/** Frame of the plane through `point` with outward `normal`: origin = the world origin projected on the plane, xDir = world X (or Y) projected. */
export function planeFrame(normal: Vec3, point: Vec3): FeatureFrame {
  const unit = normalize3(normal);
  const reference: Vec3 = Math.abs(unit[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  return { origin: scale3(unit, dot3(unit, point)), normal: unit, xDir: normalize3(sub3(reference, scale3(unit, dot3(reference, unit)))) };
}
