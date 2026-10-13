// Best snap for a cursor (geometric by distance then type priority, else grid) and ortho / polar tracking.

import type { Vec2 } from '@core/model/types';
import { nearestSnap } from '../../nearestSnap';
import type { OrthoPolarOpts, SnapPoint, SnapResult, SnapType } from './types';

/** Lower = wins a distance tie; geometric snaps beat grid. */
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

/** Nearest geometric candidate within tolerance, else the nearest grid point. */
export function snap(cursor: Vec2, candidates: SnapPoint[], gridSize: number, tolerance: number): SnapResult {
  const cx = cursor[0];
  const cy = cursor[1];

  const best = nearestSnap(candidates, (candidate) => Math.hypot(candidate.x - cx, candidate.y - cy), tolerance, SNAP_TYPE_PRIORITY);

  if (best !== null) return { x: best.x, y: best.y, type: best.type, snapped: true };

  if (gridSize > 0)
    return { x: Math.round(cx / gridSize) * gridSize, y: Math.round(cy / gridSize) * gridSize, type: 'grid', snapped: true };

  return { x: cx, y: cy, type: null, snapped: false };
}

/** Ortho (wins when both are set) snaps to the nearest horizontal/vertical from `origin`; polar to the nearest increment (default 15°). */
export function applyOrthoPolar(origin: Vec2, cursor: Vec2, opts: OrthoPolarOpts): Vec2 {
  if (!opts.ortho && !opts.polar) return cursor;

  const dx = cursor[0] - origin[0];
  const dy = cursor[1] - origin[1];
  const length = Math.sqrt(dx * dx + dy * dy);

  if (length < 1e-10) return cursor;

  if (opts.ortho) return Math.abs(dx) >= Math.abs(dy) ? [origin[0] + dx, origin[1]] : [origin[0], origin[1] + dy];

  // A missing or non-positive increment means 15° (0 from an uninitialized field would yield NaN).
  const increment = opts.polarIncrement && opts.polarIncrement > 0 ? opts.polarIncrement : Math.PI / 12;
  const rawAngle = Math.atan2(dy, dx);
  const snappedAngle = Math.round(rawAngle / increment) * increment;
  return [origin[0] + length * Math.cos(snappedAngle), origin[1] + length * Math.sin(snappedAngle)];
}
