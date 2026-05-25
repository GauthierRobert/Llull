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

import type { CadDocument, Entity, Vec2 } from '@core/model/types';
import { is2D } from '@core/model/types';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type SnapType = 'endpoint' | 'midpoint' | 'center' | 'intersection' | 'grid';

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
}

export interface SnapOpts {
  gridSize: number;
  tolerance: number;
}

export interface OrthoPolarOpts {
  ortho: boolean;
  polar: boolean;
  /** Polar angle increment in radians. Default Math.PI / 12 (15°). */
  polarIncrement?: number;
}

// ---------------------------------------------------------------------------
// Internal geometry helpers
// ---------------------------------------------------------------------------

/** Euclidean distance between two 2D points. */
function dist(ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  return Math.sqrt(dx * dx + dy * dy);
}

/** Midpoint of two 2D points. */
function mid(ax: number, ay: number, bx: number, by: number): [number, number] {
  return [(ax + bx) / 2, (ay + by) / 2];
}

/**
 * Compute the intersection point of two line segments (if any).
 * Returns null when segments are parallel or do not intersect within their extents.
 */
function segmentIntersection(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
  dx: number,
  dy: number,
): [number, number] | null {
  const r_x = bx - ax;
  const r_y = by - ay;
  const s_x = dx - cx;
  const s_y = dy - cy;

  const denom = r_x * s_y - r_y * s_x;
  if (Math.abs(denom) < 1e-10) return null; // parallel

  const t = ((cx - ax) * s_y - (cy - ay) * s_x) / denom;
  const u = ((cx - ax) * r_y - (cy - ay) * r_x) / denom;

  if (t >= 0 && t <= 1 && u >= 0 && u <= 1) {
    return [ax + t * r_x, ay + t * r_y];
  }
  return null;
}

/**
 * Extract line segments as [x1,y1,x2,y2] pairs from a 2D entity,
 * offset by the entity's world position.
 */
function entityToSegments(entity: Entity): Array<[number, number, number, number]> {
  const ox = entity.position[0];
  const oy = entity.position[1];

  switch (entity.kind) {
    case 'line': {
      return [[
        entity.start[0] + ox,
        entity.start[1] + oy,
        entity.end[0] + ox,
        entity.end[1] + oy,
      ]];
    }
    case 'polyline': {
      const segs: Array<[number, number, number, number]> = [];
      const pts = entity.points;
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i]!;
        const b = pts[i + 1]!;
        segs.push([a[0] + ox, a[1] + oy, b[0] + ox, b[1] + oy]);
      }
      if (entity.closed && pts.length >= 2) {
        const first = pts[0]!;
        const last = pts[pts.length - 1]!;
        segs.push([last[0] + ox, last[1] + oy, first[0] + ox, first[1] + oy]);
      }
      return segs;
    }
    case 'rectangle': {
      const x0 = ox;
      const y0 = oy;
      const x1 = ox + entity.width;
      const y1 = oy + entity.height;
      return [
        [x0, y0, x1, y0],
        [x1, y0, x1, y1],
        [x1, y1, x0, y1],
        [x0, y1, x0, y0],
      ];
    }
    default:
      return [];
  }
}

// ---------------------------------------------------------------------------
// collectSnapCandidates
// ---------------------------------------------------------------------------

/**
 * Derive all snap candidate points from the 2D entities in a document.
 * Returns world-space 2D snap points (entity position offset applied).
 *
 * @pure deterministic, no side effects
 */
export function collectSnapCandidates(
  document: CadDocument,
  opts: CollectOpts = {},
): SnapPoint[] {
  const doEndpoints = opts.endpoints !== false;
  const doMidpoints = opts.midpoints !== false;
  const doCenters = opts.centers !== false;
  const doIntersections = opts.intersections !== false;

  const candidates: SnapPoint[] = [];

  // Collect all line segments first (needed for intersection computation).
  const allSegments: Array<[number, number, number, number]> = [];

  for (const id of document.order) {
    const entity = document.entities[id];
    if (!entity || !is2D(entity)) continue;

    const ox = entity.position[0];
    const oy = entity.position[1];

    switch (entity.kind) {
      case 'line': {
        const ax = entity.start[0] + ox;
        const ay = entity.start[1] + oy;
        const bx = entity.end[0] + ox;
        const by = entity.end[1] + oy;

        if (doEndpoints) {
          candidates.push({ x: ax, y: ay, type: 'endpoint' });
          candidates.push({ x: bx, y: by, type: 'endpoint' });
        }
        if (doMidpoints) {
          const [mx, my] = mid(ax, ay, bx, by);
          candidates.push({ x: mx, y: my, type: 'midpoint' });
        }
        allSegments.push([ax, ay, bx, by]);
        break;
      }

      case 'polyline': {
        const pts = entity.points;
        for (let i = 0; i < pts.length; i++) {
          const p = pts[i]!;
          const px = p[0] + ox;
          const py = p[1] + oy;

          if (doEndpoints) {
            // All vertices are endpoints; first and last are "line endpoints".
            candidates.push({ x: px, y: py, type: 'endpoint' });
          }
          if (doMidpoints && i < pts.length - 1) {
            const q = pts[i + 1]!;
            const [mx, my] = mid(px, py, q[0] + ox, q[1] + oy);
            candidates.push({ x: mx, y: my, type: 'midpoint' });
          }
        }
        if (entity.closed && doMidpoints && pts.length >= 2) {
          const first = pts[0]!;
          const last = pts[pts.length - 1]!;
          const [mx, my] = mid(first[0] + ox, first[1] + oy, last[0] + ox, last[1] + oy);
          candidates.push({ x: mx, y: my, type: 'midpoint' });
        }
        const segs = entityToSegments(entity);
        allSegments.push(...segs);
        break;
      }

      case 'arc': {
        const cx = entity.center[0] + ox;
        const cy = entity.center[1] + oy;
        const r = entity.radius;

        if (doCenters) {
          candidates.push({ x: cx, y: cy, type: 'center' });
        }
        if (doEndpoints) {
          // Start and end points of the arc.
          candidates.push({
            x: cx + r * Math.cos(entity.startAngle),
            y: cy + r * Math.sin(entity.startAngle),
            type: 'endpoint',
          });
          candidates.push({
            x: cx + r * Math.cos(entity.endAngle),
            y: cy + r * Math.sin(entity.endAngle),
            type: 'endpoint',
          });
        }
        if (doMidpoints) {
          // Midpoint along the SWEPT arc (direction-respecting), so an arc that
          // crosses the 0/2π wrap still lands on the arc itself rather than the
          // opposite side. sweep is normalized to [0, 2π).
          const sweep = (((entity.endAngle - entity.startAngle) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
          const midAngle = entity.startAngle + sweep / 2;
          candidates.push({
            x: cx + r * Math.cos(midAngle),
            y: cy + r * Math.sin(midAngle),
            type: 'midpoint',
          });
        }
        break;
      }

      case 'circle': {
        const cx = entity.center[0] + ox;
        const cy = entity.center[1] + oy;

        if (doCenters) {
          candidates.push({ x: cx, y: cy, type: 'center' });
        }
        // Cardinal points as endpoints (useful snaps for circles).
        if (doEndpoints) {
          const r = entity.radius;
          candidates.push({ x: cx + r, y: cy, type: 'endpoint' });
          candidates.push({ x: cx - r, y: cy, type: 'endpoint' });
          candidates.push({ x: cx, y: cy + r, type: 'endpoint' });
          candidates.push({ x: cx, y: cy - r, type: 'endpoint' });
        }
        break;
      }

      case 'rectangle': {
        const x0 = ox;
        const y0 = oy;
        const x1 = ox + entity.width;
        const y1 = oy + entity.height;

        if (doEndpoints) {
          // Four corners.
          candidates.push({ x: x0, y: y0, type: 'endpoint' });
          candidates.push({ x: x1, y: y0, type: 'endpoint' });
          candidates.push({ x: x1, y: y1, type: 'endpoint' });
          candidates.push({ x: x0, y: y1, type: 'endpoint' });
        }
        if (doMidpoints) {
          // Four edge midpoints.
          candidates.push({ x: (x0 + x1) / 2, y: y0, type: 'midpoint' });
          candidates.push({ x: x1, y: (y0 + y1) / 2, type: 'midpoint' });
          candidates.push({ x: (x0 + x1) / 2, y: y1, type: 'midpoint' });
          candidates.push({ x: x0, y: (y0 + y1) / 2, type: 'midpoint' });
        }
        if (doCenters) {
          candidates.push({ x: (x0 + x1) / 2, y: (y0 + y1) / 2, type: 'center' });
        }
        allSegments.push(...entityToSegments(entity));
        break;
      }

      case 'point': {
        if (doEndpoints) {
          candidates.push({ x: ox, y: oy, type: 'endpoint' });
        }
        break;
      }

      // 3D solids have no 2D snap geometry — already filtered by is2D above.
      default:
        break;
    }
  }

  // Segment × segment intersections.
  if (doIntersections && allSegments.length >= 2) {
    for (let i = 0; i < allSegments.length; i++) {
      for (let j = i + 1; j < allSegments.length; j++) {
        const a = allSegments[i]!;
        const b = allSegments[j]!;
        const pt = segmentIntersection(a[0], a[1], a[2], a[3], b[0], b[1], b[2], b[3]);
        if (pt) {
          candidates.push({ x: pt[0], y: pt[1], type: 'intersection' });
        }
      }
    }
  }

  return candidates;
}

// ---------------------------------------------------------------------------
// snap
// ---------------------------------------------------------------------------

/**
 * Snap type priority order — geometric snaps beat grid.
 * Lower index = higher priority when distances are equal.
 */
const SNAP_TYPE_PRIORITY: Record<SnapType, number> = {
  endpoint: 0,
  midpoint: 1,
  center: 2,
  intersection: 3,
  grid: 4,
};

/**
 * Find the best snap for a cursor position.
 *
 * Priority: geometric snaps (endpoint > midpoint > center > intersection)
 * over grid snap, all within `tolerance`. Falls back to the nearest grid point
 * when no geometric candidate is within tolerance.
 *
 * @pure deterministic, no side effects
 */
export function snap(
  cursor: Vec2,
  candidates: SnapPoint[],
  gridSize: number,
  tolerance: number,
): SnapResult {
  const cx = cursor[0];
  const cy = cursor[1];

  let bestDist = Infinity;
  let best: SnapPoint | null = null;

  for (const candidate of candidates) {
    const d = dist(cx, cy, candidate.x, candidate.y);
    if (d <= tolerance) {
      const beatsByDist = d < bestDist - 1e-10;
      const sameDist = Math.abs(d - bestDist) <= 1e-10;
      const beatsByPriority =
        sameDist &&
        best !== null &&
        SNAP_TYPE_PRIORITY[candidate.type] < SNAP_TYPE_PRIORITY[best.type];

      if (beatsByDist || beatsByPriority) {
        bestDist = d;
        best = candidate;
      }
    }
  }

  if (best !== null) {
    return { x: best.x, y: best.y, type: best.type, snapped: true };
  }

  // No geometric snap — fall back to nearest grid point.
  if (gridSize > 0) {
    const gx = Math.round(cx / gridSize) * gridSize;
    const gy = Math.round(cy / gridSize) * gridSize;
    return { x: gx, y: gy, type: 'grid', snapped: true };
  }

  return { x: cx, y: cy, type: null, snapped: false };
}

// ---------------------------------------------------------------------------
// applyOrthoPolar
// ---------------------------------------------------------------------------

/**
 * Apply ortho / polar tracking to a raw cursor position relative to an origin.
 *
 * - Ortho: constrain to the nearest horizontal or vertical from `origin`.
 * - Polar: constrain to the nearest angle increment from `origin`
 *   (default 15°, i.e. every 15° step from 0°).
 * - When both are false, returns cursor unchanged.
 * - When both are true, ortho takes precedence (ortho is a subset of polar at 90°).
 *
 * @pure deterministic, no side effects
 */
export function applyOrthoPolar(origin: Vec2, cursor: Vec2, opts: OrthoPolarOpts): Vec2 {
  if (!opts.ortho && !opts.polar) return cursor;

  const dx = cursor[0] - origin[0];
  const dy = cursor[1] - origin[1];
  const length = Math.sqrt(dx * dx + dy * dy);

  if (length < 1e-10) return cursor; // cursor is exactly at origin

  if (opts.ortho) {
    // Constrain to horizontal (dy→0) or vertical (dx→0), whichever is closer.
    if (Math.abs(dx) >= Math.abs(dy)) {
      // Closer to horizontal.
      return [origin[0] + dx, origin[1]];
    } else {
      // Closer to vertical.
      return [origin[0], origin[1] + dy];
    }
  }

  // Polar tracking. Treat a missing OR non-positive increment as the 15° default
  // (a 0 increment from an uninitialized UI field would otherwise yield NaN).
  const increment = opts.polarIncrement && opts.polarIncrement > 0 ? opts.polarIncrement : Math.PI / 12;
  const rawAngle = Math.atan2(dy, dx);
  const snappedAngle = Math.round(rawAngle / increment) * increment;
  return [
    origin[0] + length * Math.cos(snappedAngle),
    origin[1] + length * Math.sin(snappedAngle),
  ];
}
