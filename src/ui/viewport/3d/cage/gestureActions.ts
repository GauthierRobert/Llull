// Gesture lifecycle on the stores: begin a modal gesture, commit it as ONE command through `dispatch`, or cancel it with no command.
// Non-React so the pointer, key and gizmo hooks share it and it is testable against the stores.

import { useStore } from '@ui/store';
import { useDirectEditStore } from '@ui/store/directEditStore';
import { type CageGesture, gestureCommand } from './gestureCommands';

/** Replace the in-flight gesture (the preview scheduler picks it up). */
export function updateGesture(gesture: CageGesture): void {
  useDirectEditStore.getState().setGesture(gesture);
}

/** Dispatch the in-flight gesture's command once and remember it for "Copy as CLI". Returns whether a command went out. */
export function commitGesture(): boolean {
  const edit = useDirectEditStore.getState();
  const { entityId, gesture } = edit;
  edit.setGesture(null);
  if (entityId === null || gesture === null) return false;
  const command = gestureCommand(entityId, gesture, edit.selection, edit.falloff);
  if (command === null) return false;
  useStore.getState().dispatch(command.name, command.params);
  edit.setLastCommit(command);
  return true;
}

/** Drop the in-flight gesture: nothing is dispatched, the document never saw it. */
export function cancelGesture(): void {
  useDirectEditStore.getState().setGesture(null);
}
