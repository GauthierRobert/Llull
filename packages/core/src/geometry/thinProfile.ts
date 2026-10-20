/**
 * Thin-wall regions of a 2D profile (thin extrude): an open path becomes a closed band by offsetting both sides, a closed polygon becomes a
 * ring (outer and inner polygon). Pure; sketch coordinates.
 * @invariant open path: `inside` = left of the travel direction, `outside` = right; closed polygon: `inside` = toward the centre
 */

import type { Vec2 } from '../model/types';
import { offsetPolygon, polygonArea, selfIntersects, signedArea, toCounterClockwise } from '../lib/polygon';

export const THIN_SIDES = ['centre', 'inside', 'outside'] as const;
export type ThinSide = (typeof THIN_SIDES)[number];

export type ThinRegion =
  | { readonly kind: 'band'; readonly polygon: Vec2[]; readonly area: number }
  | { readonly kind: 'ring'; readonly outer: Vec2[]; readonly inner: Vec2[]; readonly area: number };

/** Share of the thickness on the (left, right) side of an open path / (inside, outside) of a closed outline. */
const SPLIT: Readonly<Record<ThinSide, readonly [number, number]>> = { centre: [0.5, 0.5], inside: [1, 0], outside: [0, 1] };

const MIN_MITER_DOT = -0.8;

/** Left offset of an open path by `distance` (negative = right) with mitred corners; null when a corner turns back on itself. */
function offsetPath(path: ReadonlyArray<Vec2>, distance: number): Vec2[] | null {
  const normals: Vec2[] = [];
  for (let i = 0; i + 1 < path.length; i++) {
    const [a, b] = [path[i] as Vec2, path[i + 1] as Vec2];
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    normals.push([-(b[1] - a[1]) / length, (b[0] - a[0]) / length]);
  }
  const result: Vec2[] = [];
  for (let i = 0; i < path.length; i++) {
    const point = path[i] as Vec2;
    const before = normals[i - 1];
    const after = normals[i];
    if (before === undefined || after === undefined) {
      const normal = (before ?? after) as Vec2;
      result.push([point[0] + normal[0] * distance, point[1] + normal[1] * distance]);
      continue;
    }
    const dot = before[0] * after[0] + before[1] * after[1];
    if (dot < MIN_MITER_DOT) return null;
    const scale = distance / (1 + dot);
    result.push([point[0] + (before[0] + after[0]) * scale, point[1] + (before[1] + after[1]) * scale]);
  }
  return result;
}

const withoutRepeats = (points: ReadonlyArray<Vec2>): Vec2[] =>
  points.filter((point, i) => i === 0 || Math.hypot(point[0] - (points[i - 1] as Vec2)[0], point[1] - (points[i - 1] as Vec2)[1]) > 1e-9);

/**
 * Wall region of `profile` for a wall of `thickness` on `side`.
 * @failure thickness not finite / <= 0, open path with < 2 distinct points, closed polygon with < 3, corner sharper than ~157 degrees,
 *   wall wider than the outline allows (self-intersecting or inverted result) -> message
 */
export function thinRegion(profile: ReadonlyArray<Vec2>, closed: boolean, thickness: number, side: ThinSide): ThinRegion | string {
  if (!Number.isFinite(thickness) || thickness <= 0) return `thin thickness must be a finite number > 0 (got ${String(thickness)})`;
  const [left, right] = SPLIT[side];
  const points = withoutRepeats(profile);
  if (!closed) {
    if (points.length < 2) return 'an open thin profile needs at least 2 distinct points';
    const leftPath = offsetPath(points, left * thickness);
    const rightPath = offsetPath(points, -right * thickness);
    if (leftPath === null || rightPath === null)
      return 'a corner of the path turns back on itself (sharper than 157 degrees); the offset band is undefined';
    const polygon = [...leftPath, ...rightPath.reverse()];
    if (selfIntersects(polygon) || polygonArea(polygon) < 1e-12)
      return `thickness ${thickness} makes the offset band self-intersect; use a thinner wall`;
    return { kind: 'band', polygon, area: polygonArea(polygon) };
  }
  if (points.length < 3) return 'a closed thin profile needs at least 3 distinct points';
  const base = toCounterClockwise(points);
  const outer = right === 0 ? base : offsetPolygon(base, right * thickness);
  const inner = left === 0 ? base : offsetPolygon(base, -left * thickness);
  if (selfIntersects(outer) || selfIntersects(inner) || signedArea(inner) <= 1e-12 || signedArea(inner) >= signedArea(outer))
    return `thickness ${thickness} is too large for this outline (the inner offset collapses or inverts); use a thinner wall`;
  return { kind: 'ring', outer, inner, area: polygonArea(outer) - polygonArea(inner) };
}
