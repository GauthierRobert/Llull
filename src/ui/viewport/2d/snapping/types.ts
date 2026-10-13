/** Snap types and option shapes for the 2D drafting viewport. */

import type { Entity } from '@core/model/types';

export type SnapType = 'endpoint' | 'midpoint' | 'center' | 'intersection' | 'grid' | 'perpendicular' | 'tangent' | 'extension' | 'nearest';

export interface SnapPoint {
  readonly x: number;
  readonly y: number;
  readonly type: SnapType;
}

export interface SnapResult {
  readonly x: number;
  readonly y: number;
  /** null = nothing within tolerance and no grid. */
  readonly type: SnapType | null;
  /** false = raw cursor. */
  readonly snapped: boolean;
}

export interface CollectOpts {
  /** Default true: endpoints … tangents; false: extensions, nearest. */
  endpoints?: boolean;
  midpoints?: boolean;
  centers?: boolean;
  intersections?: boolean;
  perpendiculars?: boolean;
  tangents?: boolean;
  extensions?: boolean;
  /** Rejected entities (hidden) give no snaps. */
  isVisible?: (entity: Entity) => boolean;
  /** Plan-section depth of drawn solids (sectionCut); undefined = uncut. */
  cutDepth?: number | undefined;
  nearest?: boolean;
}

export interface OrthoPolarOpts {
  ortho: boolean;
  polar: boolean;
  /** Radians; default π/12. */
  polarIncrement?: number;
}
