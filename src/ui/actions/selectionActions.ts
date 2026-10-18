// Selection actions shared by toolbar, shortcuts and properties panel: gather params → dispatch.

import type { Vec3 } from '@core/model/types';
import { buildingElementOf } from '@aec/index';
import { rotatedEntityBounds } from '@core/geometry/rotatedBounds';
import { useStore, useViewportStore } from '@ui/store';
import { isEntityOnLockedLayer } from '@ui/viewport/entityVisibility';

/** Selected ids whose layer is not locked (a locked layer can still hold a stale selection). */
function editableSelection(): string[] {
  const { selection, entities, layers } = useStore.getState().document;
  return selection.filter((id) => {
    const entity = entities[id];
    return entity === undefined || !isEntityOnLockedLayer(entity, layers);
  });
}

/** Fewest commands; generated building geometry is deleted through its element (walls take their openings). */
export function deleteSelection(): void {
  const parts = partitionSelection();
  if (parts === null) return;
  const { elementIds, entityIds } = parts;
  if (elementIds.length > 0) dispatchStep('delete_building_element', { elementIds }, false);
  // A mixed selection is two commands but one local undo step.
  if (entityIds.length > 0) dispatchStep('delete_entities', { ids: entityIds }, elementIds.length > 0);
}

/** Dispatch one command of a multi-command action; `joinPrevious` folds it into the last local undo step. */
function dispatchStep(name: string, params: unknown, joinPrevious: boolean): void {
  const { dispatch } = useStore.getState();
  if (joinPrevious) dispatch(name, params, { coalesce: true });
  else dispatch(name, params);
}

const DUPLICATE_GAP = 1.5; // document units

/** Selection split into building elements (owning generated geometry) and plain entities; null when empty. */
function partitionSelection(): { elementIds: string[]; entityIds: string[] } | null {
  const { document } = useStore.getState();
  const editable = editableSelection();
  if (editable.length === 0) return null;
  const elementIds = new Set<string>();
  const entityIds: string[] = [];
  for (const id of editable) {
    const elementId = buildingElementOf(document, id);
    if (elementId === null) entityIds.push(id);
    else elementIds.add(elementId);
  }
  return { elementIds: [...elementIds], entityIds };
}

/** X offset that places copies of the selection clear of the originals. */
function duplicateOffset(ids: readonly string[]): Vec3 {
  const { document } = useStore.getState();
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  for (const id of ids) {
    const entity = document.entities[id];
    if (entity === undefined) continue;
    const bounds = rotatedEntityBounds(entity);
    minX = Math.min(minX, bounds.min[0]);
    maxX = Math.max(maxX, bounds.max[0]);
  }
  const width = Number.isFinite(maxX - minX) ? maxX - minX : 0;
  return [width + DUPLICATE_GAP, 0, 0];
}

/** Copies beside the originals in one undo step; a single copy becomes the selection. */
export function duplicateSelection(): void {
  const state = useStore.getState();
  const selection = editableSelection();
  if (selection.length === 0) return;
  state.dispatch('duplicate_entities', { ids: selection, offset: duplicateOffset(selection) }, { selectAffected: selection.length === 1 });
}

/** One undo step per kind; building geometry moves through its element (plan move, skipped when delta has Z). */
export function moveSelection(delta: Vec3, options: { joinPrevious?: boolean } = {}): void {
  const parts = partitionSelection();
  if (parts === null) return;
  const { elementIds, entityIds } = parts;
  const joinPrevious = options.joinPrevious === true;
  let dispatched = false;
  if (elementIds.length > 0 && delta[2] === 0) {
    dispatchStep('move_building_element', { elementIds, delta: [delta[0], delta[1]] }, joinPrevious);
    dispatched = true;
  }
  // Local undo: a mixed move is one step; a held arrow key (`joinPrevious`) is one step too.
  if (entityIds.length > 0) {
    dispatchStep('move_entities', { ids: entityIds, delta }, joinPrevious || dispatched);
  }
}

/** Blender H: hides the selection in the viewport (local filter, not a command) and clears it. */
export function hideSelection(): void {
  const { document, clearSelection } = useStore.getState();
  const { selection } = document;
  if (selection.length === 0) return;
  useViewportStore.getState().hideEntities(selection);
  clearSelection();
}

/** Blender Shift+H: hides everything but the selection. */
export function isolateSelection(): void {
  const { selection, order } = useStore.getState().document;
  if (selection.length === 0) return;
  useViewportStore.getState().isolateEntities(selection, order);
}
