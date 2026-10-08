/**
 * @layer ui/viewport/3d
 *
 * Section-plane equation in RENDER space (world − renderOrigin, the space three.js clips in).
 * The plane passes through the world point `normal * offset`; with the floating origin that point
 * sits at `normal * offset − renderOrigin`, so the constant gains `+ normal · renderOrigin`.
 */

import type { Vec3 } from '@core/model/types';
import type { ClipAxis } from '@ui/store';

const AXIS_INDEX: Record<ClipAxis, number> = { x: 0, y: 1, z: 2 };

export interface RenderClipPlane {
  /** Unit normal (±X / ±Y / ±Z). */
  readonly normal: Vec3;
  /** `normal · X + constant = 0` in render space. */
  readonly constant: number;
}

/** @pure */
export function renderClipPlane(
  axis: ClipAxis,
  flipped: boolean,
  offset: number,
  renderOrigin: Vec3,
): RenderClipPlane {
  const index = AXIS_INDEX[axis];
  const sign = flipped ? -1 : 1;
  const normal: [number, number, number] = [0, 0, 0];
  normal[index] = sign;
  return { normal, constant: -offset + sign * (renderOrigin[index] ?? 0) };
}
