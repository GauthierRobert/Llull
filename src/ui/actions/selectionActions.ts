/**
 * @layer ui/actions
 *
 * Actions on the current selection, shared by the main toolbar, keyboard shortcuts and the
 * properties panel. Each one only gathers params and dispatches commands (PRIME DIRECTIVE).
 */

import type { Vec3 } from '@core/model/types';
import { buildingElementOf } from '@aec/index';
import { rotatedEntityBounds } from '@core/commands/sceneRotatedBounds';
import { useStore } from '@ui/store';

/**
 * Delete the selection in as few commands as possible. Generated building geometry is deleted
 * through its element (walls take their openings).
 * @affects dispatches delete_building_element and/or delete_entities; no-op on empty selection
 */
export function deleteSelection(): void {
  const state = useStore.getState();
  if (state.document.selection.length === 0) return;
  const { elementIds, entityIds } = partitionSelection();
  if (elementIds.length > 0) state.dispatch('delete_building_element', { elementIds });
  // A mixed selection is two commands but one local undo step.
  if (entityIds.length > 0)
    dispatchStep('delete_entities', { ids: entityIds }, elementIds.length > 0);
}

/** Dispatch one command of a multi-command action; `joinPrevious` folds it into the last local undo step. */
function dispatchStep(name: string, params: unknown, joinPrevious: boolean): void {
  const { dispatch } = useStore.getState();
  if (joinPrevious) dispatch(name, params, { coalesce: true });
  else dispatch(name, params);
}

/** Gap (document units) between a duplicated selection and its originals. */
const DUPLICATE_GAP = 1.5;

/** Selection ids split into building elements (owning generated geometry) and plain entities. */
function partitionSelection(): { elementIds: string[]; entityIds: string[] } {
  const { document } = useStore.getState();
  const elementIds = new Set<string>();
  const entityIds: string[] = [];
  for (const id of document.selection) {
    const elementId = buildingElementOf(document, id);
    if (elementId === null) entityIds.push(id);
    else elementIds.add(elementId);
  }
  return { elementIds: [...elementIds], entityIds };
}

/** X offset that places copies of the selection clear of the originals. */
function duplicateOffset(): Vec3 {
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
  return [width + DUPLICATE_GAP, 0, 0];
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
  // One duplicate command per entity; locally they fold into one undo step.
  selection.forEach((id, index) => {
    state.dispatch('duplicate_entity', { id, offset }, { selectAffected, coalesce: index > 0 });
  });
}

/**
 * Translate the selection by `delta` in one undo step per kind: plain entities via move_entities,
 * generated building geometry via its element (plan move — skipped when delta has a Z component).
 * @affects dispatches move_entities and/or move_building_element; no-op on empty selection
 */
export function moveSelection(delta: Vec3, options: { joinPrevious?: boolean } = {}): void {
  const state = useStore.getState();
  if (state.document.selection.length === 0) return;
  const { elementIds, entityIds } = partitionSelection();
  const joinPrevious = options.joinPrevious === true;
  let dispatched = false;
  if (elementIds.length > 0 && delta[2] === 0) {
    dispatchStep(
      'move_building_element',
      { elementIds, delta: [delta[0], delta[1]] },
      joinPrevious,
    );
    dispatched = true;
  }
  // Local undo: a mixed move is one step; a held arrow key (`joinPrevious`) is one step too.
  if (entityIds.length > 0) {
    dispatchStep('move_entities', { ids: entityIds, delta }, joinPrevious || dispatched);
  }
}
