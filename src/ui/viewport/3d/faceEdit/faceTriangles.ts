// Display triangles of an entity for face picking, cached per entity version (entities are replaced, never mutated: L3).

import type { Entity } from '@core/model/types';
import { entityToTriangles } from '@core/geometry/entityTriangles';
import type { Triangle } from '@core/geometry/triangles';
import { diagonalOf, triangleAdjacency } from './faceMesh';

export interface PickableTriangles {
  readonly triangles: readonly Triangle[];
  readonly adjacency: readonly (readonly number[])[];
  /** Bounding-box diagonal: the scale of drag steps. */
  readonly size: number;
}

const cache = new WeakMap<Entity, PickableTriangles>();

export function pickableTriangles(entity: Entity): PickableTriangles {
  const cached = cache.get(entity);
  if (cached !== undefined) return cached;
  const triangles = entityToTriangles(entity, { components: {} });
  const built = { triangles, adjacency: triangleAdjacency(triangles), size: diagonalOf(triangles) };
  cache.set(entity, built);
  return built;
}
