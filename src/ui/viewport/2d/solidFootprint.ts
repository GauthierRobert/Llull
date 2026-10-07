/**
 * @layer ui/viewport/2d
 *
 * Top-view footprint of 3D solids in the 2D drafting view: the XY extent of the entity's
 * world-space (rotation-aware) bounding box, drawn as an outline so solids are visible and
 * pickable next to 2D shapes. Bounds come from core (`rotatedEntityBounds`,
 * `instanceBoundsFromDoc`); nothing is computed here.
 */

import { instanceBoundsFromDoc } from '@core/commands/sceneBounds';
import { rotatedEntityBounds } from '@core/commands/sceneRotatedBounds';
import type { CadDocument, Entity, Vec2 } from '@core/model/types';
import { is3D } from '@core/model/types';

export interface FootprintRect {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

/**
 * XY footprint of a 3D solid, or null for 2D shapes and non-finite bounds.
 * @pure
 */
export function solidFootprint(document: CadDocument, entity: Entity): FootprintRect | null {
  if (!is3D(entity)) return null;
  const { min, max } =
    entity.kind === 'instance'
      ? instanceBoundsFromDoc(entity, document)
      : rotatedEntityBounds(entity);
  const rect = { minX: min[0], minY: min[1], maxX: max[0], maxY: max[1] };
  return Object.values(rect).every(Number.isFinite) ? rect : null;
}

/** Closed outline (5 points) of a footprint, for rendering. @pure */
export function footprintOutline(rect: FootprintRect): Vec2[] {
  return [
    [rect.minX, rect.minY],
    [rect.maxX, rect.minY],
    [rect.maxX, rect.maxY],
    [rect.minX, rect.maxY],
    [rect.minX, rect.minY],
  ];
}

/** Squared distance from `point` to the footprint OUTLINE. @pure */
export function footprintOutlineDistSq(rect: FootprintRect, point: Vec2): number {
  const dx = Math.max(rect.minX - point[0], 0, point[0] - rect.maxX);
  const dy = Math.max(rect.minY - point[1], 0, point[1] - rect.maxY);
  const inside = dx === 0 && dy === 0;
  if (!inside) return dx * dx + dy * dy;
  const edge = Math.min(
    point[0] - rect.minX,
    rect.maxX - point[0],
    point[1] - rect.minY,
    rect.maxY - point[1],
  );
  return edge * edge;
}
