/** A piece of the folded solid: its exact recipe plus its pure-TS tessellation, built from one kernel leaf entity. */

import { DEFAULT_LAYER_ID, type Entity, type ShapeRecipe, type Vec3 } from '@core/model/types';
import { orientOutward } from '@core/geometry/meshVolume';
import { solidTriangles } from '@core/geometry/solidTriangles';

export const SHEET_COLOR = '#9fb3c4';

export interface Piece {
  readonly recipe: ShapeRecipe;
  readonly positions: number[];
  readonly indices: number[];
}

export const leaf = (id: string, kind: 'extrusion' | 'revolution', geometry: object, position: Vec3, rotation: Vec3): Entity =>
  ({ id, kind, ...geometry, position, rotation, layerId: DEFAULT_LAYER_ID, color: SHEET_COLOR }) as Entity;

/** Piece of an extrusion / revolution entity (recipe = the entity, mesh = its triangles wound outward). */
export function solidPiece(entity: Entity): Piece {
  const positions: number[] = [];
  const indices: number[] = [];
  for (const triangle of solidTriangles(entity)) {
    const base = positions.length / 3;
    for (const corner of triangle) positions.push(...corner);
    indices.push(base, base + 1, base + 2);
  }
  return { recipe: { op: 'solid', entity }, positions, indices: orientOutward(positions, indices) };
}
