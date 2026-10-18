// Click handler shared by every panel row: highlight the item on the model (select its entities + beacon its markers); a second click
// on the highlighted row clears it.

import { useCallback } from 'react';
import { useStore } from '@ui/store';
import { type PanelFocus, useFocusStore } from '@ui/store/focusStore';

export function useFocusItem(): (focus: PanelFocus) => void {
  const select = useStore((s) => s.select);
  const clearSelection = useStore((s) => s.clearSelection);
  return useCallback(
    (focus: PanelFocus) => {
      const { focus: current, setFocus } = useFocusStore.getState();
      if (current?.key === focus.key) {
        setFocus(null);
        if (focus.entityIds.length > 0) clearSelection();
        return;
      }
      setFocus(focus);
      if (focus.entityIds.length > 0) select([...focus.entityIds]);
    },
    [select, clearSelection],
  );
}
