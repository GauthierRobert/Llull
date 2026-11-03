// The clip planes the renderer applies right now (render space, three.js convention: kept while `n . p + c >= 0`), shared with the picking
// code: a ray hit on a clipped-away part of a solid is not a hit (it would select what the user cannot see).

import type { ClipPlaneSpec } from './sectionBoxMath';

let planes: readonly ClipPlaneSpec[] = [];

export function setActiveClipPlanes(next: readonly ClipPlaneSpec[]): void {
  planes = next;
}

/** True when `point` (render space) lies on the clipped-away side of any active plane. */
export function isClippedAway(point: { readonly x: number; readonly y: number; readonly z: number }): boolean {
  return planes.some(({ normal, constant }) => normal[0] * point.x + normal[1] * point.y + normal[2] * point.z + constant < -1e-9);
}
