/**
 * @layer ui/viewport/2d
 *
 * Pick the best snap for a cursor position, and apply ortho / polar tracking.
 */

import type { Vec2 } from '@core/model/types';
import type { OrthoPolarOpts, SnapPoint, SnapResult, SnapType } from './types';
import { dist } from './geometry';

/**
 * Snap type priority order — geometric snaps beat grid.
 * Lower index = higher priority when distances are equal.
 * Priority: endpoint > midpoint > center > intersection > perpendicular > tangent > extension > nearest > grid
 */
const SNAP_TYPE_PRIORITY: Record<SnapType, number> = {
  endpoint: 0,
  midpoint: 1,
  center: 2,
  intersection: 3,
  perpendicular: 4,
  tangent: 5,
  extension: 6,
  nearest: 7,
  grid: 8,
};

/**
 * Find the best snap for a cursor position.
 *
 * Priority: endpoint > midpoint > center > intersection > perpendicular > tangent >
 * extension > nearest > grid.
 * Falls back to the nearest grid point when no geometric candidate is within tolerance.
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
  const increment =
    opts.polarIncrement && opts.polarIncrement > 0 ? opts.polarIncrement : Math.PI / 12;
  const rawAngle = Math.atan2(dy, dx);
  const snappedAngle = Math.round(rawAngle / increment) * increment;
  return [origin[0] + length * Math.cos(snappedAngle), origin[1] + length * Math.sin(snappedAngle)];
}
