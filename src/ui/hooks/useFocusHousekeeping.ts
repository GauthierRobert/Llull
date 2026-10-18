// Keeps the panel highlight honest: it is dropped when the sidebar switches panel or closes, and when an entity it names is deleted,
// moved or replaced (undo, open, regenerate), so beacons and the banner never point at something that is no longer there.

import { useEffect } from 'react';
import type { CadDocument } from '@core/model/types';
import { useLayoutStore, useStore } from '@ui/store';
import { useFocusStore } from '@ui/store/focusStore';

/** Whether any entity the focus names changed identity between two documents (pure commands: identity = unchanged). */
function focusedEntitiesChanged(entityIds: readonly string[], next: CadDocument, previous: CadDocument): boolean {
  return entityIds.some((id) => next.entities[id] === undefined || next.entities[id] !== previous.entities[id]);
}

export function useFocusHousekeeping(): void {
  useEffect(() => {
    const clear = (): void => useFocusStore.getState().setFocus(null);
    const unsubscribeDocument = useStore.subscribe((state, previous) => {
      const focus = useFocusStore.getState().focus;
      if (focus === null || state.document === previous.document) return;
      if (focusedEntitiesChanged(focus.entityIds, state.document, previous.document)) clear();
    });
    const unsubscribeLayout = useLayoutStore.subscribe((state, previous) => {
      if (state.sidebarTab !== previous.sidebarTab || (previous.sidebarOpen && !state.sidebarOpen)) clear();
    });
    return () => {
      unsubscribeDocument();
      unsubscribeLayout();
    };
  }, []);
}
