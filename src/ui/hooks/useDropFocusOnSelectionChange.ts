// A panel that focuses what it selects (Objects, Assembly) drops its highlight as soon as the selection no longer is that item, so the
// banner never names something that is not the selection any more.

import { useEffect } from 'react';
import { useStore } from '@ui/store';
import { useFocusStore } from '@ui/store/focusStore';

export function useDropFocusOnSelectionChange(keyPrefix: string): void {
  const selection = useStore((s) => s.document.selection);
  const focus = useFocusStore((s) => s.focus);
  useEffect(() => {
    if (focus === null || !focus.key.startsWith(keyPrefix)) return;
    const same = focus.entityIds.length === selection.length && focus.entityIds.every((id) => selection.includes(id));
    if (!same) useFocusStore.getState().setFocus(null);
  }, [focus, selection, keyPrefix]);
}
