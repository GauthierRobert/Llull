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
import type { Entity, LineEntity, PolylineEntity, CircleEntity, RectangleEntity } from '@core/model/types';

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

// ---------------------------------------------------------------------------
// Entity pick distance (for ModifyPickInteraction)
// ---------------------------------------------------------------------------

/**
 * Squared distance from point P to the segment AB.
 * @pure
 */
export function pointToSegDistSq(p: Vec2, a: Vec2, b: Vec2): number {
  const abx = b[0] - a[0];
  const aby = b[1] - a[1];
  const apx = p[0] - a[0];
  const apy = p[1] - a[1];
  const lenSq = abx * abx + aby * aby;
  let t = lenSq > 0 ? (apx * abx + apy * aby) / lenSq : 0;
  t = Math.max(0, Math.min(1, t));
  const cx = a[0] + t * abx - p[0];
  const cy = a[1] + t * aby - p[1];
  return cx * cx + cy * cy;
}

/**
 * Minimum squared distance from a world-space pick point to a 2D entity.
 *
 * All 2D entity geometry is LOCAL to the entity's work plane; `entity.position`
 * is the work-plane origin in world space. The world-space pick is shifted into
 * the entity's local frame and all geometry is compared in that frame.
 *
 * Handles: line, polyline, circle, rectangle.
 * Returns Infinity for unsupported kinds.
 *
 * @pure
 */
export function entityDistSq(entity: Entity, worldPick: Vec2): number {
  // Shift pick into local frame — same for every kind.
  const ox = entity.position[0];
  const oy = entity.position[1];
  const pick: Vec2 = [worldPick[0] - ox, worldPick[1] - oy];

  switch (entity.kind) {
    case 'line': {
      const l = entity as LineEntity;
      return pointToSegDistSq(pick, l.start, l.end);
    }
    case 'polyline': {
      const poly = entity as PolylineEntity;
      let best = Infinity;
      for (let i = 0; i < poly.points.length - 1; i++) {
        const d = pointToSegDistSq(pick, poly.points[i]!, poly.points[i + 1]!);
        if (d < best) best = d;
      }
      if (poly.closed && poly.points.length > 1) {
        const d = pointToSegDistSq(
          pick,
          poly.points[poly.points.length - 1]!,
          poly.points[0]!,
        );
        if (d < best) best = d;
      }
      return best;
    }
    case 'circle': {
      const c = entity as CircleEntity;
      const dx = pick[0] - c.center[0];
      const dy = pick[1] - c.center[1];
      const d = Math.sqrt(dx * dx + dy * dy) - c.radius;
      return d * d;
    }
    case 'rectangle': {
      const r = entity as RectangleEntity;
      // Rectangle corners are in local space (lower-left at local origin).
      const tl: Vec2 = [0, r.height];
      const tr: Vec2 = [r.width, r.height];
      const bl: Vec2 = [0, 0];
      const br: Vec2 = [r.width, 0];
      return Math.min(
        pointToSegDistSq(pick, bl, br),
        pointToSegDistSq(pick, br, tr),
        pointToSegDistSq(pick, tr, tl),
        pointToSegDistSq(pick, tl, bl),
      );
    }
    default:
      return Infinity;
  }
}
