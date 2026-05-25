/**
 * @layer ui/viewport/2d
 *
 * Pure geometry helpers for the interactive 2D modify tools.
 *
 * All functions are deterministic and side-effect free — they compute
 * dispatch params from raw pick coordinates. Unit-tested in tests/unit/.
 *
 * @pure
 */

import type { Vec2 } from '@core/model/types';

// ---------------------------------------------------------------------------
// Nearest-vertex picking for polylines (fillet / chamfer)
// ---------------------------------------------------------------------------

export interface NearestVertexResult {
  /** 0-based index of the nearest vertex. */
  vertexIndex: number;
  /** World-space position of that vertex. */
  point: Vec2;
  /** Squared distance from the pick point to the vertex. */
  distSq: number;
}

/**
 * Find the vertex on a polyline that is nearest to a pick point.
 *
 * Returns null when the points array is empty.
 *
 * @pure
 * @failure returns null when points is empty
 */
export function nearestVertex(
  points: ReadonlyArray<Vec2>,
  pick: Vec2,
): NearestVertexResult | null {
  if (points.length === 0) return null;

  let bestIdx = 0;
  let bestDistSq = Infinity;

  for (let i = 0; i < points.length; i++) {
    const p = points[i]!;
    const dx = p[0] - pick[0];
    const dy = p[1] - pick[1];
    const dSq = dx * dx + dy * dy;
    if (dSq < bestDistSq) {
      bestDistSq = dSq;
      bestIdx = i;
    }
  }

  return {
    vertexIndex: bestIdx,
    point: points[bestIdx]!,
    distSq: bestDistSq,
  };
}

// ---------------------------------------------------------------------------
// Offset side determination
// ---------------------------------------------------------------------------

/**
 * Determine the sign of the offset distance from a pick point relative to a line.
 *
 * Positive → the pick point is to the LEFT of start→end (same as offset_2d convention).
 * Negative → to the RIGHT.
 * Zero → pick is on the line; returns +1 by default.
 *
 * @pure
 */
export function offsetSideSign(start: Vec2, end: Vec2, pick: Vec2): 1 | -1 {
  // Cross product of (end-start) × (pick-start)
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  const px = pick[0] - start[0];
  const py = pick[1] - start[1];
  const cross = dx * py - dy * px;
  return cross >= 0 ? 1 : -1;
}

// ---------------------------------------------------------------------------
// Distance between two 2D points
// ---------------------------------------------------------------------------

/**
 * Euclidean distance between two 2D points.
 * @pure
 */
export function dist2(a: Vec2, b: Vec2): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  return Math.sqrt(dx * dx + dy * dy);
}
