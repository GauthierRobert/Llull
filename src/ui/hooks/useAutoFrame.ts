// Local mode: `fit_view` (quiet, joined to the content's undo step) when the document goes from empty to non-empty.

import { useEffect } from 'react';
import { useStore, useToolStore } from '@ui/store';
import { isLocalMode } from '@ui/store/localMode';

export function useAutoFrame(): void {
  useEffect(
    () =>
      useStore.subscribe((state, previous) => {
        const becameNonEmpty = previous.document.order.length === 0 && state.document.order.length > 0;
        // Online the camera is shared: framing would move every client's view.
        if (!becameNonEmpty || !isLocalMode(state)) return;
        const direction = useToolStore.getState().viewMode === '2d' ? 'current' : 'iso';
        state.dispatch('fit_view', { direction }, { quiet: true, coalesce: true });
      }),
    [],
  );
}
