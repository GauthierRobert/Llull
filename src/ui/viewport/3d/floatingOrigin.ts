// Floating origin: float32 rendering jitters far from (0,0,0), so the scene renders relative to an origin tracking the
// camera target; document coordinates stay float64 and are offset only at render time.

import { distanceSq3 } from '@lib/vec3';

/** Drift beyond `threshold` (1e4 keeps float32 error < ~1 mm up to ~1e7); sooner = visible jumps, later = jitter. */
export function shouldRebase(
  cameraTarget: readonly [number, number, number],
  currentOrigin: readonly [number, number, number],
  threshold = 1e4,
): boolean {
  return distanceSq3(cameraTarget, currentOrigin) > threshold * threshold;
}

/** Target snapped to a `gridSize` grid: the origin moves in discrete steps (no drift, no micro-rebases). */
export function snapOriginToTarget(cameraTarget: readonly [number, number, number], gridSize = 1e4): [number, number, number] {
  return [
    Math.round(cameraTarget[0] / gridSize) * gridSize,
    Math.round(cameraTarget[1] / gridSize) * gridSize,
    Math.round(cameraTarget[2] / gridSize) * gridSize,
  ];
}

/** Render-time only: the document position is never touched. */
export function toRenderPosition(
  worldPos: readonly [number, number, number],
  renderOrigin: readonly [number, number, number],
): [number, number, number] {
  return [worldPos[0] - renderOrigin[0], worldPos[1] - renderOrigin[1], worldPos[2] - renderOrigin[2]];
}
