/**
 * @layer ui/viewport/2d
 *
 * Pure snapping helpers for the 2D drafting viewport.
 *
 * All functions are deterministic and side-effect free — they derive snap
 * candidates from document entities and select the best candidate for a given
 * cursor position. No React, no store reads, no mutations.
 *
 * These helpers are unit-tested in tests/unit/snapping.test.ts.
 */

export type {
  SnapType,
  SnapPoint,
  SnapResult,
  CollectOpts,
  SnapOpts,
  OrthoPolarOpts,
} from './snapping/types';
export {
  perpendicularFoot,
  snapPerpendicular,
  tangentPointsToCircle,
  snapTangentToCircle,
  snapExtension,
  nearestOnSegment,
  nearestOnArc,
} from './snapping/geometry';
export { collectSnapCandidates } from './snapping/candidates';
export { snap, applyOrthoPolar } from './snapping/resolveSnap';
