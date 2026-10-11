/**
 * @layer ui/viewport/3d
 *
 * Placement of the ground contact-shadow patch. A fixed 40-unit patch at the origin drowns a tiny
 * part in a grey slab and misses a large or off-origin model entirely; this sizes the patch from
 * the scene footprint and keeps it on the ground (z = 0, or lower when the scene dips below it).
 */

import type { Bounds } from '@core/commands/sceneTypes';
import type { Vec3 } from '@core/model/types';

/** The original fixed patch, kept for an empty scene. */
const DEFAULT_SCALE = 40;
const DEFAULT_FAR = 20;
/** Patch side as a multiple of the scene's largest horizontal extent. */
const FOOTPRINT_MARGIN = 2;
/** Smallest patch side, so a flat / point scene never yields a zero-size plane. */
const MIN_SCALE = 1e-6;

export interface ContactShadowPlane {
  /** Render-space centre of the patch. */
  readonly position: Vec3;
  /** Side length of the (square) patch. */
  readonly scale: number;
  /** Shadow camera depth range above the patch. */
  readonly far: number;
}

/** @pure @invariant bounds null -> the original fixed patch at the origin */
export function computeContactShadowPlane(
  bounds: Bounds | null,
  renderOrigin: Vec3,
): ContactShadowPlane {
  if (!bounds) return { position: [0, 0, -0.001], scale: DEFAULT_SCALE, far: DEFAULT_FAR };
  const extentX = bounds.max[0] - bounds.min[0];
  const extentY = bounds.max[1] - bounds.min[1];
  const scale = Math.max(Math.max(extentX, extentY) * FOOTPRINT_MARGIN, MIN_SCALE);
  const height = bounds.max[2] - Math.min(bounds.min[2], 0);
  const ground = Math.min(bounds.min[2], 0) - scale * 1e-3;
  return {
    position: [
      (bounds.min[0] + bounds.max[0]) / 2 - renderOrigin[0],
      (bounds.min[1] + bounds.max[1]) / 2 - renderOrigin[1],
      ground - renderOrigin[2],
    ],
    scale,
    far: Math.max(height * 1.5, scale * 0.25),
  };
}
