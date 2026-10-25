// The part of an entity that shapes its tessellation. Placement (position, rotation) is applied by the shell's group and look / bookkeeping
// fields never reach the triangles, so a move, recolour or rename must not re-tessellate a heavy sweep or loft.

import type { BaseEntity } from '@core/model/types';

// Never add a BaseEntity field that shapes geometry to NON_GEOMETRY: its edits would stop re-tessellating.
type NonGeometry = 'position' | 'rotation' | 'color' | 'name' | 'layerId' | 'decals' | 'tags' | 'materialId' | 'patternSourceId';

const NON_GEOMETRY: ReadonlySet<string> = new Set<NonGeometry>([
  'position',
  'rotation',
  'color',
  'name',
  'layerId',
  'decals',
  'tags',
  'materialId',
  'patternSourceId',
]);

export type GeometryFields<E extends BaseEntity> = Omit<E, NonGeometry>;

export function geometryFields<E extends BaseEntity>(entity: E): GeometryFields<E> {
  return Object.fromEntries(Object.entries(entity).filter(([key]) => !NON_GEOMETRY.has(key))) as GeometryFields<E>;
}
