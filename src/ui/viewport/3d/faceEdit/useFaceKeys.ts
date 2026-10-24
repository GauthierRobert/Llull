// Capture-phase keys of face edit mode (before the global shortcuts, which skip defaultPrevented keys). The decision is the pure `faceKeyAction`.

import { useCallback } from 'react';
import { useCaptureKeydown } from '@ui/hooks/useCaptureKeydown';
import { isEditingKeyEvent } from '@ui/hooks/useKeyboardShortcuts';
import { useFaceEditStore } from '@ui/store/faceEditStore';
import { cancelFaceDrag } from './faceEditActions';
import { faceKeyAction } from './faceEditKeys';

export function useFaceKeys(active: boolean): void {
  const onKey = useCallback((event: KeyboardEvent): void => {
    if (isEditingKeyEvent(event) || event.ctrlKey || event.metaKey || event.altKey) return;
    const edit = useFaceEditStore.getState();
    const action = faceKeyAction(event.key, { dragging: edit.value !== null, hasPick: edit.pick !== null });
    if (action === null) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.repeat) return;
    if (action.kind === 'cancel_drag') cancelFaceDrag();
    else if (action.kind === 'clear_pick') edit.clearPick();
    else if (action.kind === 'exit') edit.stop();
    else edit.setOp(action.op);
  }, []);
  useCaptureKeydown(active ? onKey : null);
}
