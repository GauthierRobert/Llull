/**
 * @layer ui/hooks
 *
 * Actions on the current selection, shared by the main toolbar, keyboard shortcuts and the
 * properties panel. Each one only gathers params and dispatches commands (PRIME DIRECTIVE).
 */

import type { Vec3 } from '@core/model/types';
import { buildingElementOf } from '@core/commands/building';
import { rotatedEntityBounds } from '@core/commands/scene';
import { useStore } from '@ui/store';
import { PLACEMENT_GAP } from '@ui/components/toolbar/solidPresets';

/**
 * Delete the selection in as few commands as possible. Generated building geometry is deleted
 * through its element (walls take their openings).
 * @affects dispatches delete_building_element and/or delete_entities; no-op on empty selection
 */
export function deleteSelection(): void {
  const state = useStore.getState();
  const selection = state.document.selection;
  if (selection.length === 0) return;
  const elementIds = new Set<string>();
  const entityIds: string[] = [];
  for (const id of selection) {
    const elementId = buildingElementOf(state.document, id);
    if (elementId === null) entityIds.push(id);
    else elementIds.add(elementId);
  }
  if (elementIds.size > 0) {
    state.dispatch('delete_building_element', { elementIds: [...elementIds] });
  }
  if (entityIds.length > 0) state.dispatch('delete_entities', { ids: entityIds });
}

/** X offset that places copies of the selection clear of the originals. */
export function duplicateOffset(): Vec3 {
  const { document } = useStore.getState();
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  for (const id of document.selection) {
    const entity = document.entities[id];
    if (entity === undefined) continue;
    const bounds = rotatedEntityBounds(entity);
    minX = Math.min(minX, bounds.min[0]);
    maxX = Math.max(maxX, bounds.max[0]);
  }
  const width = Number.isFinite(maxX - minX) ? maxX - minX : 0;
  return [width + PLACEMENT_GAP, 0, 0];
}

/**
 * Copy every selected entity beside the originals; a single copy becomes the new selection.
 * @affects dispatches duplicate_entity once per selected id; no-op on empty selection
 */
export function duplicateSelection(): void {
  const state = useStore.getState();
  const selection = state.document.selection;
  if (selection.length === 0) return;
  const offset = duplicateOffset();
  const selectAffected = selection.length === 1;
  for (const id of selection) {
    state.dispatch('duplicate_entity', { id, offset }, { selectAffected });
  }
}

/**
 * Translate every selected entity by `delta`.
 * @affects dispatches move_entity once per selected id; no-op on empty selection
 */
export function moveSelection(delta: Vec3): void {
  const state = useStore.getState();
  for (const id of state.document.selection) state.dispatch('move_entity', { id, delta });
}
