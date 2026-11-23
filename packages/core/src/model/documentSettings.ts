/** The settings slices `CadDocument` inherits: dimension styles and the site context. */

import type { DimensionStyleFields } from './dimensionStyle';
import type { SiteContextFields } from './siteContext';

/**
 * Layout of the exact faces of a fitted sweep (`SweepDesign.faceLayout`). Present ('joined'): new fitted sweeps join the ring edges of a run into 2 faces
 * (`createEmptyDocument` sets it). Absent: one face per ring edge, which is what documents made before the joined layout hold; their stored persistent
 * names (`f<k>`, `e(f<a>|f<b>)`) refer to it, so every fitted sweep of such a document, new ones included, keeps it. Loading never adds the field.
 */
export interface SweepLayoutFields {
  sweepFaceLayout?: 'joined';
}

export interface DocumentSettingsFields extends DimensionStyleFields, SiteContextFields, SweepLayoutFields {}

/** `fresh` (a new empty document) with the sweep face layout of `base`: a document that has none keeps having none. */
export function withSweepLayoutOf<T extends SweepLayoutFields>(fresh: T, base: SweepLayoutFields): T {
  const { sweepFaceLayout: _own, ...rest } = fresh;
  return (base.sweepFaceLayout === undefined ? rest : { ...rest, sweepFaceLayout: base.sweepFaceLayout }) as T;
}
