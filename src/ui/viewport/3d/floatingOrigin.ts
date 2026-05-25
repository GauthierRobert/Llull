/**
 * @layer ui/viewport/3d
 *
 * Pure helpers for floating-origin / camera-relative rendering.
 *
 * three.js renders in float32. Geometry far from world (0,0,0) jitters because
 * vertex positions lose precision. The fix: render the scene relative to a
 * "render origin" that tracks the camera target. Document coordinates stay
 * double-precision; the offset is subtracted only at render time.
 *
 * These are pure functions so they can be unit-tested without a DOM/canvas.
 */

/** Euclidean distance² between two Vec3 triples — avoids sqrt for threshold checks. */
function distanceSq(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
): number {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  const dz = a[2] - b[2];
  return dx * dx + dy * dy + dz * dz;
}

/**
 * Returns true when the camera target has drifted far enough from the current
 * render origin to warrant rebasing.
 *
 * threshold: distance in world units beyond which we rebase (default 1e4).
 * Rebasing too eagerly causes a one-frame jump; too lazily causes jitter at
 * extreme distances. 1e4 keeps float32 error below ~1 mm for coordinates up to ~1e7.
 */
export function shouldRebase(
  cameraTarget: readonly [number, number, number],
  currentOrigin: readonly [number, number, number],
  threshold = 1e4,
): boolean {
  return distanceSq(cameraTarget, currentOrigin) > threshold * threshold;
}

/**
 * Snap the render origin to the camera target, rounded to a grid to avoid
 * sub-unit micro-rebases on every pan. Grid size matches the rebase threshold.
 *
 * Snapping to a grid means the origin jumps in discrete steps, which avoids
 * accumulating floating-point drift in the offset itself.
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
 * Subtract the render origin from an entity's world-space position so it is
 * expressed relative to the render origin. The result is what three.js receives
 * as the mesh position — float32-safe because the magnitude is bounded by the
 * rebase threshold.
 *
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
