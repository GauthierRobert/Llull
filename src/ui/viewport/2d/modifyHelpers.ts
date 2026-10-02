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
import type {
  CadDocument,
  Entity,
  EntityId,
  LineEntity,
  PolylineEntity,
  CircleEntity,
  RectangleEntity,
  ArcEntity,
  EllipseEntity,
  SplineEntity,
} from '@core/model/types';

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
export function nearestVertex(points: ReadonlyArray<Vec2>, pick: Vec2): NearestVertexResult | null {
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
 * Handles: line, polyline, circle, rectangle, point, arc (as its full circle),
 * ellipse (sampled), spline (through its control points).
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
        const d = pointToSegDistSq(pick, poly.points[poly.points.length - 1]!, poly.points[0]!);
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
    case 'point':
      return dist2(pick, [0, 0]);
    case 'arc': {
      const a = entity as ArcEntity;
      const d = Math.hypot(pick[0] - a.center[0], pick[1] - a.center[1]) - a.radius;
      return d * d;
    }
    case 'ellipse': {
      const el = entity as EllipseEntity;
      const samples: Vec2[] = [];
      for (let i = 0; i <= ELLIPSE_PICK_SAMPLES; i++) {
        const t = (i / ELLIPSE_PICK_SAMPLES) * 2 * Math.PI;
        samples.push([
          el.center[0] + el.radiusX * Math.cos(t),
          el.center[1] + el.radiusY * Math.sin(t),
        ]);
      }
      return chainDistSq(pick, samples, false);
    }
    case 'spline': {
      const sp = entity as SplineEntity;
      return chainDistSq(pick, sp.points, sp.closed);
    }
    default:
      return Infinity;
  }
}

/** Segments used to approximate an ellipse outline for picking. */
const ELLIPSE_PICK_SAMPLES = 48;

/** Minimum squared distance from `pick` to a chain of segments (optionally closed). @pure */
function chainDistSq(pick: Vec2, points: ReadonlyArray<Vec2>, closed: boolean): number {
  let best = Infinity;
  for (let i = 0; i < points.length - 1; i++) {
    best = Math.min(best, pointToSegDistSq(pick, points[i]!, points[i + 1]!));
  }
  if (closed && points.length > 1) {
    best = Math.min(best, pointToSegDistSq(pick, points[points.length - 1]!, points[0]!));
  }
  return best;
}

/**
 * Id of the entity nearest to `worldPick` within `tolerance` world units, or null.
 * @pure
 */
export function nearestEntityId(
  document: CadDocument,
  worldPick: Vec2,
  tolerance: number,
): EntityId | null {
  const toleranceSq = tolerance * tolerance;
  let bestId: EntityId | null = null;
  let bestDist = Infinity;
  for (const id of document.order) {
    const entity = document.entities[id];
    if (!entity) continue;
    const dSq = entityDistSq(entity, worldPick);
    if (dSq < toleranceSq && dSq < bestDist) {
      bestDist = dSq;
      bestId = id;
    }
  }
  return bestId;
}

/** Point-in-polygon (even-odd ray cast) in local coordinates. @pure */
function polygonContains(points: ReadonlyArray<Vec2>, pick: Vec2): boolean {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, yi] = points[i]!;
    const [xj, yj] = points[j]!;
    if (yi > pick[1] !== yj > pick[1] && pick[0] < ((xj - xi) * (pick[1] - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * Enclosed area of a closed 2D entity when `worldPick` lies inside it, else null.
 * Closed kinds: rectangle, circle, ellipse, closed polyline.
 * @pure
 */
export function enclosingArea(entity: Entity, worldPick: Vec2): number | null {
  const pick: Vec2 = [worldPick[0] - entity.position[0], worldPick[1] - entity.position[1]];
  switch (entity.kind) {
    case 'rectangle': {
      const r = entity as RectangleEntity;
      const inside = pick[0] >= 0 && pick[0] <= r.width && pick[1] >= 0 && pick[1] <= r.height;
      return inside ? r.width * r.height : null;
    }
    case 'circle': {
      const c = entity as CircleEntity;
      const inside = dist2(pick, c.center) <= c.radius * c.radius;
      return inside ? Math.PI * c.radius * c.radius : null;
    }
    case 'ellipse': {
      const el = entity as EllipseEntity;
      if (el.radiusX <= 0 || el.radiusY <= 0) return null;
      const u = (pick[0] - el.center[0]) / el.radiusX;
      const v = (pick[1] - el.center[1]) / el.radiusY;
      return u * u + v * v <= 1 ? Math.PI * el.radiusX * el.radiusY : null;
    }
    case 'polyline': {
      const poly = entity as PolylineEntity;
      if (!poly.closed || poly.points.length < 3 || !polygonContains(poly.points, pick)) {
        return null;
      }
      let twiceArea = 0;
      for (let i = 0, j = poly.points.length - 1; i < poly.points.length; j = i++) {
        twiceArea +=
          poly.points[j]![0] * poly.points[i]![1] - poly.points[i]![0] * poly.points[j]![1];
      }
      return Math.abs(twiceArea) / 2;
    }
    default:
      return null;
  }
}

/**
 * Selection pick: the nearest outline within `tolerance` wins; otherwise the smallest closed
 * shape containing the point; otherwise null.
 * @pure
 */
export function pickEntityId(
  document: CadDocument,
  worldPick: Vec2,
  tolerance: number,
): EntityId | null {
  const onOutline = nearestEntityId(document, worldPick, tolerance);
  if (onOutline !== null) return onOutline;
  let bestId: EntityId | null = null;
  let bestArea = Infinity;
  for (const id of document.order) {
    const entity = document.entities[id];
    if (!entity) continue;
    const area = enclosingArea(entity, worldPick);
    if (area !== null && area < bestArea) {
      bestArea = area;
      bestId = id;
    }
  }
  return bestId;
}
