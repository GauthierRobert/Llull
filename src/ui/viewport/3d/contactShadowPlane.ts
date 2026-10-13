// Ground contact-shadow patch sized from the scene footprint (a fixed 40-unit patch drowned tiny parts and missed
// large / off-origin ones), on z = 0 or lower when the scene dips below it.

import { type Bounds, boundsCenter } from '@core/geometry/bounds';
import type { Vec3 } from '@core/model/types';
import { toRenderPosition } from './floatingOrigin';

/** Empty scene. */
const DEFAULT_SCALE = 40;
const DEFAULT_FAR = 20;
/** × the largest horizontal extent. */
const FOOTPRINT_MARGIN = 2;
/** Flat / point scenes never yield a zero-size plane. */
const MIN_SCALE = 1e-6;

export interface ContactShadowPlane {
  /** Render space. */
  readonly position: Vec3;
  /** Square side. */
  readonly scale: number;
  /** Shadow camera depth above the patch. */
  readonly far: number;
}

export function computeContactShadowPlane(bounds: Bounds | null, renderOrigin: Vec3): ContactShadowPlane {
  if (!bounds) return { position: [0, 0, -0.001], scale: DEFAULT_SCALE, far: DEFAULT_FAR };
  const extentX = bounds.max[0] - bounds.min[0];
  const extentY = bounds.max[1] - bounds.min[1];
  const scale = Math.max(Math.max(extentX, extentY) * FOOTPRINT_MARGIN, MIN_SCALE);
  const height = bounds.max[2] - Math.min(bounds.min[2], 0);
  const ground = Math.min(bounds.min[2], 0) - scale * 1e-3;
  const [centreX, centreY] = boundsCenter(bounds);
  return { position: toRenderPosition([centreX, centreY, ground], renderOrigin), scale, far: Math.max(height * 1.5, scale * 0.25) };
}
