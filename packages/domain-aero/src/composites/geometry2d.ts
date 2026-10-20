/** Planar helpers of the part frame: polygon membership with a boundary tolerance and the pieces / area of a ply. */

import type { CompositePart, Ply } from '@core/model/composites';
import type { Vec2 } from '@core/model/types';
import { pointInPolygon, projectOntoSegment } from '@lib/polygon';
import { cutPieces } from './cutPieces';

const BOUNDARY_EPS = 1e-6;

/** Distance from `p` to the nearest edge of `polygon`. */
export function boundaryDistance(p: Vec2, polygon: readonly Vec2[]): number {
  return Math.min(...polygon.map((a, i) => projectOntoSegment(p, a, polygon[(i + 1) % polygon.length] as Vec2).distance));
}

/** True when `p` is inside `polygon` or within `eps` of its boundary. */
export const insideOrOn = (p: Vec2, polygon: readonly Vec2[], eps = BOUNDARY_EPS): boolean =>
  pointInPolygon(p, polygon) || boundaryDistance(p, polygon) <= eps;

/** The polygons a ply covers (the part outline for a whole-face ply), divided by its darts and splices. */
export const piecesOf = (ply: Ply, part: CompositePart): readonly (readonly Vec2[])[] => {
  const base = ply.boundary.kind === 'whole_face' ? [part.outline] : ply.boundary.polygons;
  return ply.cuts === undefined || ply.cuts.length === 0 ? base : cutPieces(base, ply.cuts);
};

/** True when the ply covers the flat point (boundary counts as covered). */
export const plyCovers = (ply: Ply, part: CompositePart, p: Vec2): boolean => piecesOf(ply, part).some((piece) => insideOrOn(p, piece));
