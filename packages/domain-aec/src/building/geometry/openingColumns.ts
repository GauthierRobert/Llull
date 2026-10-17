/** Door / window openings that cut through a column standing in their wall line. */

import type { BuildingModel, ColumnElement, OpeningElement, WallElement } from '@core/model/building';
import { wallFrame } from './wallGeometry';

export interface OpeningColumnOverlap {
  readonly column: ColumnElement;
  /** Smallest overlap of the opening and the column along the wall, across it and vertically (document units). */
  readonly depth: number;
}

function overlap(centreA: number, halfA: number, centreB: number, halfB: number): number {
  return halfA + halfB - Math.abs(centreA - centreB);
}

/**
 * Columns of the wall's level whose solid intersects the opening box (along the wall, through its thickness, sill to head).
 * @invariant straight walls only; a column is an axis-aligned rectangle (circular: its diameter square)
 * @invariant depth > tolerance
 */
export function columnsInOpening(
  building: BuildingModel,
  wall: WallElement,
  opening: Pick<OpeningElement, 'offset' | 'width' | 'height' | 'sillHeight'>,
  tolerance: number,
): OpeningColumnOverlap[] {
  const frame = wallFrame(wall);
  const found: OpeningColumnOverlap[] = [];
  for (const column of Object.values(building.elements)) {
    if (column.category !== 'column' || column.levelId !== wall.levelId) continue;
    const [dx, dy] = [column.location[0] - wall.start[0], column.location[1] - wall.start[1]];
    const along = dx * frame.direction[0] + dy * frame.direction[1];
    const across = dx * frame.normal[0] + dy * frame.normal[1];
    const [halfX, halfY] = column.shape === 'circular' ? [column.width / 2, column.width / 2] : [column.width / 2, column.depth / 2];
    const halfAlong = halfX * Math.abs(frame.direction[0]) + halfY * Math.abs(frame.direction[1]);
    const halfAcross = halfX * Math.abs(frame.normal[0]) + halfY * Math.abs(frame.normal[1]);
    const openingBottom = wall.baseOffset + opening.sillHeight;
    const depth = Math.min(
      overlap(along, halfAlong, opening.offset, opening.width / 2),
      overlap(across, halfAcross, 0, wall.thickness / 2),
      overlap(column.height / 2, column.height / 2, openingBottom + opening.height / 2, opening.height / 2),
    );
    if (depth > tolerance) found.push({ column, depth });
  }
  return found;
}
