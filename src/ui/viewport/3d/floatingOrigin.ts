/**
 * @layer ui/viewport/3d
 *
 * Pure helpers for floating-origin rendering. three.js renders in float32, so geometry far from
 * world (0,0,0) jitters; the scene is rendered relative to a "render origin" that tracks the
 * camera target. Document coordinates stay double-precision; the offset is subtracted only at
 * render time.
 */

import { distanceSq3 } from '@lib/vec3';

/**
 * True when the camera target has drifted more than `threshold` world units (default 1e4) from the
 * render origin. 1e4 keeps float32 error below ~1 mm for coordinates up to ~1e7; rebasing more
 * eagerly causes a one-frame jump, less eagerly causes jitter.
 */
export function shouldRebase(
  cameraTarget: readonly [number, number, number],
  currentOrigin: readonly [number, number, number],
  threshold = 1e4,
): boolean {
  return distanceSq3(cameraTarget, currentOrigin) > threshold * threshold;
}

/**
 * The camera target rounded to a `gridSize` grid (default = the rebase threshold), so the origin
 * jumps in discrete steps instead of accumulating drift or micro-rebasing on every pan.
 */
export function snapOriginToTarget(
  cameraTarget: readonly [number, number, number],
  gridSize = 1e4,
): [number, number, number] {
  return [
    Math.round(cameraTarget[0] / gridSize) * gridSize,
    Math.round(cameraTarget[1] / gridSize) * gridSize,
    Math.round(cameraTarget[2] / gridSize) * gridSize,
  ];
}

/**
 * `worldPos` relative to the render origin: the float32-safe mesh position three.js receives.
 * The DOCUMENT position is never touched — this is purely a render-time transform.
 */
export function toRenderPosition(
  worldPos: readonly [number, number, number],
  renderOrigin: readonly [number, number, number],
): [number, number, number] {
  return [
    worldPos[0] - renderOrigin[0],
    worldPos[1] - renderOrigin[1],
    worldPos[2] - renderOrigin[2],
  ];
}
