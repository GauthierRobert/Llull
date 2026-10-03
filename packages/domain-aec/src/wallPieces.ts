/**
 * Vertical wall pieces left solid after cutting openings.
 * @layer domain-aec
 */

import type { OpeningElement } from '@core/model/building';
import type { WallExtent } from './wallGeometry';

export interface WallPiece {
  readonly s0: number;
  readonly s1: number;
  readonly z0: number;
  readonly z1: number;
}

/** Vertical rectangular pieces [s0,s1]×[z0,z1] (wall-local) left solid after cutting the openings. */
export function wallPieces<Wall extends { readonly height: number }>(
  wall: Wall,
  openings: ReadonlyArray<OpeningElement>,
  extent: WallExtent,
): WallPiece[] {
  const pieces: WallPiece[] = [];
  let cursor = extent.start;
  for (const opening of openings) {
    const left = Math.max(opening.offset - opening.width / 2, extent.start);
    const right = Math.min(opening.offset + opening.width / 2, extent.end);
    if (left > cursor) pieces.push({ s0: cursor, s1: left, z0: 0, z1: wall.height });
    if (opening.sillHeight > 0) pieces.push({ s0: left, s1: right, z0: 0, z1: opening.sillHeight });
    const head = opening.sillHeight + opening.height;
    if (head < wall.height) pieces.push({ s0: left, s1: right, z0: head, z1: wall.height });
    cursor = Math.max(cursor, right);
  }
  if (extent.end > cursor) pieces.push({ s0: cursor, s1: extent.end, z0: 0, z1: wall.height });
  return pieces.filter((piece) => piece.s1 - piece.s0 > 1e-9 && piece.z1 - piece.z0 > 1e-9);
}
