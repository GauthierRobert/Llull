// OrbitControls (three-stdlib) only stops damping once the eye moves < 1e-3 world units per frame, so under the demand
// frameloop the coast keeps rendering longer the further the camera is zoomed out (≈ +37 frames per decade of
// distance). Stopping once a frame moves the view less than a fraction of a pixel ends it at the same visual point
// at every scale.

import { toRadians } from '@lib/angle';

/** A coast slower than this per frame is invisible, so it can end without a visible stop. */
export const SETTLE_STEP_PIXELS = 0.25;

/** Screen-space size, in pixels, of a view step of `stepWorld` seen from `distance` away. */
export function viewStepPixels(stepWorld: number, distance: number, fovDegrees: number, viewportHeightPx: number): number {
  if (distance <= 0 || viewportHeightPx <= 0) return 0;
  const radiansPerPixel = toRadians(fovDegrees) / viewportHeightPx;
  return stepWorld / distance / radiansPerPixel;
}

/** True while the view still coasts (moved this frame) but too slowly to see. */
export function shouldSettleCoast(stepWorld: number, distance: number, fovDegrees: number, viewportHeightPx: number): boolean {
  return stepWorld > 0 && viewStepPixels(stepWorld, distance, fovDegrees, viewportHeightPx) < SETTLE_STEP_PIXELS;
}
