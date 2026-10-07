/**
 * @layer ui/viewport
 * @pure Single visibility rule shared by every renderer, picker and snap collector.
 */

import type { CadDocument, Entity } from '@core/model/types';

/**
 * Visible = its document layer is visible AND neither its layer nor the entity itself is hidden
 * by the render-only viewport filters.
 */
export function isEntityVisible(
  entity: Entity,
  layers: CadDocument['layers'],
  hiddenLayerIds: ReadonlySet<string>,
  hiddenEntityIds: ReadonlySet<string>,
): boolean {
  if (layers[entity.layerId]?.visible === false) return false;
  return !hiddenLayerIds.has(entity.layerId) && !hiddenEntityIds.has(entity.id);
}
