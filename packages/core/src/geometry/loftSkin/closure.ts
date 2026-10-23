/** Continuity of a closed (periodic) loft across its closing seam, where the last section returns to the first. */

import type { Vec3 } from '../../model/vectors';
import { dot3, len3 } from '../../lib/vec3';
import { surfaceDerivatives, surfaceDomain } from '../../lib/nurbs/surface';
import type { NurbsSurfaceData } from '../../lib/nurbs/surfaceTypes';

const SAMPLES = 24;

/**
 * Largest angle (radians) between the tangents across the skin, d/dv, at the end of the v range and at its start, over u samples: 0 for a
 * smoothly closing loft (G1 at the periodic seam), larger when the closing skin kinks.
 */
export function closureJump(surface: NurbsSurfaceData): number {
  const [[u0, u1], [v0, v1]] = surfaceDomain(surface);
  let worst = 0;
  for (let k = 0; k <= SAMPLES; k++) {
    const u = u0 + ((u1 - u0) * k) / SAMPLES;
    const across = (v: number): Vec3 => (surfaceDerivatives(surface, u, v, 1)[0] as Vec3[])[1] as Vec3;
    const [a, b] = [across(v1), across(v0)];
    if (len3(a) < 1e-12 || len3(b) < 1e-12) continue;
    worst = Math.max(worst, Math.acos(Math.min(1, Math.max(-1, dot3(a, b) / (len3(a) * len3(b))))));
  }
  return worst;
}
