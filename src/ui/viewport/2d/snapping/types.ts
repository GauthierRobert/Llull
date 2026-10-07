/**
 * @layer ui/viewport/2d
 *
 * Snap types and option shapes for the 2D drafting viewport.
 */

import type { Entity } from '@core/model/types';

export type SnapType =
  | 'endpoint'
  | 'midpoint'
  | 'center'
  | 'intersection'
  | 'grid'
  | 'perpendicular'
  | 'tangent'
  | 'extension'
  | 'nearest';

export interface SnapPoint {
  readonly x: number;
  readonly y: number;
  readonly type: SnapType;
}

export interface SnapResult {
  /** The snapped world position. */
  readonly x: number;
  readonly y: number;
  /** Which snap type was used (null when no snap was within tolerance and no grid). */
  readonly type: SnapType | null;
  /** Whether a snap was found (false = raw cursor position). */
  readonly snapped: boolean;
}

export interface CollectOpts {
  /** Include endpoint snaps. Default true. */
  endpoints?: boolean;
  /** Include midpoint snaps. Default true. */
  midpoints?: boolean;
  /** Include center snaps. Default true. */
  centers?: boolean;
  /** Include intersection snaps. Default true. */
  intersections?: boolean;
  /** Include perpendicular snaps (foot of perpendicular to lines/segments). Default true. */
  perpendiculars?: boolean;
  /** Include tangent snaps (tangent point from reference to circles/arcs). Default true. */
  tangents?: boolean;
  /** Include extension snaps (along imaginary line extension beyond endpoints). Default false. */
  extensions?: boolean;
  /** Entities rejected here contribute no snap geometry (hidden layers / entities). Default: all. */
  isVisible?: (entity: Entity) => boolean;
  /** Include nearest snaps (closest point on any entity geometry). Default false. */
  nearest?: boolean;
}

export interface OrthoPolarOpts {
  ortho: boolean;
  polar: boolean;
  /** Polar angle increment in radians. Default Math.PI / 12 (15°). */
  polarIncrement?: number;
}
