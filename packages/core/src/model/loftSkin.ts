import type { NurbsSurfaceData } from '../lib/nurbs/surfaceTypes';

/**
 * Exact skin of a loft (v4, local to `position`): one NURBS face per coupled segment, from the TypeScript skinning of end conditions, alignment, closed
 * lofts, centrelines, guides and rational sections. The exact kernel sews and caps them; `rings` is then only the dense display / Manifold fallback.
 * @invariant >= 1 face; with `closed` the faces join the last section to the first and nothing is capped
 */
export interface LoftSkin {
  faces?: ReadonlyArray<NurbsSurfaceData>;
  closed?: boolean;
  /** Planar caps the kernel closes the skin with: 2 (default), 1 when one end is a point, 0 for a closed loft. */
  caps?: 0 | 1 | 2;
}
