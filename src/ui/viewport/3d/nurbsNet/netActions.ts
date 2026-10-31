// Pole drag lifecycle on the stores: each move re-runs the move_poles command as a local dry run (nurbs edits need no kernel) for the ghost,
// the release dispatches exactly ONE command. The store document is never touched by a preview.

import { runPreview } from '@ui/preview/runPreview';
import { useStore } from '@ui/store';
import { usePreviewStore } from '@ui/store/previewStore';
import { useNurbsNetStore } from '@ui/store/nurbsNetStore';
import type { Vec3 } from '@core/model/types';
import { type PoleId, isNurbsNetEntity, polesMoveCommand, samePole } from './controlNet';

/** The poles a drag of `pole` moves: the whole selection when `pole` belongs to it, else just `pole`. */
function movedPoles(pole: PoleId): readonly PoleId[] {
  const { selected } = useNurbsNetStore.getState();
  return selected.some((candidate) => samePole(candidate, pole)) ? selected : [pole];
}

/** Move the dragged pole to the displacement `delta` and refresh the ghost. */
export function updatePoleDrag(entityId: string, pole: PoleId, delta: Vec3): void {
  const { document } = useStore.getState();
  const entity = document.entities[entityId];
  const command = isNurbsNetEntity(entity) ? polesMoveCommand(entity, movedPoles(pole), delta, useNurbsNetStore.getState().falloff) : null;
  if (command === null) {
    usePreviewStore.getState().setOutcome(null);
    useNurbsNetStore.getState().setDrag({ entityId, pole, delta, preview: null });
    return;
  }
  const outcome = runPreview(document, command.name, command.params);
  usePreviewStore.getState().setOutcome(outcome, 'add');
  const changed = outcome.ok ? outcome.entities.find((candidate) => candidate.id === entityId) : undefined;
  useNurbsNetStore.getState().setDrag({ entityId, pole, delta, preview: isNurbsNetEntity(changed) ? changed : null });
}

/** Dispatch the dragged pole as one command. @returns whether a command went out */
export function commitPoleDrag(): boolean {
  const { drag, setDrag } = useNurbsNetStore.getState();
  usePreviewStore.getState().setOutcome(null);
  setDrag(null);
  if (drag === null) return false;
  const entity = useStore.getState().document.entities[drag.entityId];
  const command = isNurbsNetEntity(entity)
    ? polesMoveCommand(entity, movedPoles(drag.pole), drag.delta, useNurbsNetStore.getState().falloff)
    : null;
  if (command === null) return false;
  useStore.getState().dispatch(command.name, command.params);
  return true;
}

/** Drop the drag: no command, no ghost. */
export function cancelPoleDrag(): void {
  usePreviewStore.getState().setOutcome(null);
  useNurbsNetStore.getState().setDrag(null);
}
