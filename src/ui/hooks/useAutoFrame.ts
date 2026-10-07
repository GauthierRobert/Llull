/**
 * @layer ui/hooks
 *
 * useAutoFrame — frames the camera (`fit_view`, same path as Zoom extents) when the document goes
 * from empty to non-empty (first shape, template, opened project, live snapshot). Quiet: the
 * status bar keeps the summary of the command that added the content. Not re-run on later edits.
 */

import { useEffect } from 'react';
import { useStore, useToolStore } from '@ui/store';

export function useAutoFrame(): void {
  useEffect(
    () =>
      useStore.subscribe((state, previous) => {
        const becameNonEmpty =
          previous.document.order.length === 0 && state.document.order.length > 0;
        if (!becameNonEmpty) return;
        const direction = useToolStore.getState().viewMode === '2d' ? 'current' : 'iso';
        state.dispatch('fit_view', { direction }, { quiet: true });
      }),
    [],
  );
}
