// Capture-phase keyboard handling of cage edit mode (before the global shortcuts, which skip defaultPrevented keys). The decision is
// the pure `cageKeyAction`; this hook only applies it to the stores.

import { useCallback } from 'react';
import { isEditingKeyEvent } from '@ui/hooks/useKeyboardShortcuts';
import { useCaptureKeydown } from '@ui/hooks/useCaptureKeydown';
import { useStore } from '@ui/store';
import { useDirectEditStore } from '@ui/store/directEditStore';
import { type CageKeyAction, cageKeyAction } from './cageKeys';
import { defaultInsetThickness, isSelectionEmpty } from './cageSelection';
import { cancelGesture, commitGesture, updateGesture } from './gestureActions';

function apply(action: CageKeyAction): void {
  const edit = useDirectEditStore.getState();
  switch (action.kind) {
    case 'cancel_gesture':
      return cancelGesture();
    case 'commit_gesture':
      commitGesture();
      return;
    case 'end_tool':
      return edit.setTool('select');
    case 'clear_selection':
      return edit.setSelection({ vertices: [], edges: [], faces: [] });
    case 'exit':
      return edit.exit();
    case 'mode':
      return edit.setElementMode(action.mode);
    case 'loop_cut_tool':
      return edit.setTool(edit.tool === 'loop_cut' ? 'select' : 'loop_cut');
    case 'cuts':
      return edit.setCuts(edit.cuts + action.delta);
    case 'axis_lock':
      return; // handled by the pointer hook, which owns the drag
    case 'inset': {
      const cage = edit.entityId === null ? undefined : useStore.getState().document.entities[edit.entityId];
      if (cage?.kind === 'subdivision') updateGesture({ kind: 'inset', thickness: defaultInsetThickness(cage, edit.selection) });
      return;
    }
  }
}

/** Active while the cage of `entityId` is in edit mode. */
export function useCageKeys(active: boolean): void {
  const onKey = useCallback((event: KeyboardEvent): void => {
    if (isEditingKeyEvent(event)) return;
    const edit = useDirectEditStore.getState();
    const action = cageKeyAction(event, {
      gestureActive: edit.gesture !== null,
      tool: edit.tool,
      selectionEmpty: isSelectionEmpty(edit.selection),
      hasFaceSelection: edit.selection.faces.length > 0,
    });
    if (action === null) return;
    event.preventDefault();
    event.stopPropagation();
    if (!event.repeat || action.kind === 'cuts') apply(action);
  }, []);
  useCaptureKeydown(active ? onKey : null);
}
