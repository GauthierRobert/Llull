/** Constant-stack regions of a ply piece: where the plies below it stop, the ply sits at a different height (06 CMP FR-CMP-54). */

import type { CompositePart, Ply } from '@core/model/composites';
import type { Vec2 } from '@core/model/types';
import { pointInPolygon } from '@lib/polygon';
import { type CutFace, cutFaces } from './cutPieces';
import { boundaryDistance, insideOrOn, piecesOf } from './geometry2d';

const bounds = (polygon: readonly Vec2[]): readonly [number, number, number, number] => [
  Math.min(...polygon.map(([x]) => x)),
  Math.min(...polygon.map(([, y]) => y)),
  Math.max(...polygon.map(([x]) => x)),
  Math.max(...polygon.map(([, y]) => y)),
];

const overlaps = (a: readonly Vec2[], b: readonly Vec2[]): boolean => {
  const [p, q] = [bounds(a), bounds(b)];
  return p[0] <= q[2] && q[0] <= p[2] && p[1] <= q[3] && q[1] <= p[3];
};

/** True when `cover` contains all of `piece`: its vertices and edge midpoints lie in or on it and no vertex of `cover` lies strictly inside `piece`. */
function covers(cover: readonly Vec2[], piece: readonly Vec2[]): boolean {
  const midpoints = piece.map((a, k): Vec2 => {
    const b = piece[(k + 1) % piece.length] as Vec2;
    return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  });
  if (![...piece, ...midpoints].every((point) => insideOrOn(point, cover, 1e-7))) return false;
  return !cover.some((vertex) => pointInPolygon(vertex, piece) && boundaryDistance(vertex, piece) > 1e-7);
}

/**
 * The regions of `piece` over which the stack below `ply` is constant: `piece` cut along the footprints of the lower plies that do not cover it
 * completely (identical footprints counted once). A piece covered by every lower ply stays whole.
 */
export function stackRegions(part: CompositePart, lower: readonly Ply[], piece: readonly Vec2[]): CutFace[] {
  const seen = new Set<string>();
  const cuts = lower
    .flatMap((other) => piecesOf(other, part))
    .filter((polygon) => {
      const key = JSON.stringify(polygon);
      if (seen.has(key)) return false;
      seen.add(key);
      return overlaps(polygon, piece) && !covers(polygon, piece);
    })
    .map((polygon) => ({ kind: 'splice' as const, path: [...polygon, polygon[0] as Vec2] }));
  return cuts.length === 0 ? [{ outer: [...piece], holes: [] }] : cutFaces([piece], cuts);
}
