// Drag lifecycle of a face handle on the stores: every move asks the backend for a preview, the release dispatches exactly ONE command.
// Previews never touch the store document; `commit` is the only `dispatch`.

import { requestRemotePreview, endRemotePreview } from '@ui/preview/remote/remotePreviewSession';
import { useStore } from '@ui/store';
import { useFaceEditStore } from '@ui/store/faceEditStore';
import { faceCommand } from './faceEditModel';

/** Face commands that take `preview: true` (a dry run that skips the exact volume report and topology note). */
const PREVIEW_FLAGGED = new Set(['move_faces', 'delete_faces']);

/** Set the drag value and refresh the ghost (an idle value clears it). */
export function updateFaceDrag(value: number): void {
  const { entityId, pick, op } = useFaceEditStore.getState();
  useFaceEditStore.getState().setValue(value);
  const command = entityId === null || pick === null ? null : faceCommand(op, entityId, pick, value);
  if (command === null) endRemotePreview();
  else requestRemotePreview(command.name, PREVIEW_FLAGGED.has(command.name) ? { ...command.params, preview: true } : command.params);
}

/** Dispatch the dragged value as one command. @returns whether a command went out */
export function commitFaceDrag(): boolean {
  const { entityId, pick, op, value } = useFaceEditStore.getState();
  endRemotePreview();
  const command = entityId === null || pick === null || value === null ? null : faceCommand(op, entityId, pick, value);
  useFaceEditStore.getState().clearPick();
  if (command === null) return false;
  useStore.getState().dispatch(command.name, command.params);
  return true;
}

/** Drop the drag: no command, no ghost; the pick stays so the handle can be grabbed again. */
export function cancelFaceDrag(): void {
  endRemotePreview();
  useFaceEditStore.getState().setValue(null);
}
