/**
 * @layer ui/hooks
 *
 * useAutoFrame — frames the camera (`fit_view`, same path as Zoom extents) when the document goes
 * from empty to non-empty (first shape, template, opened project, live snapshot). Quiet: the
 * status bar keeps the summary of the command that added the content, and the framing joins that
 * command's undo step. Local mode only. Not re-run on later edits.
 */

import { useEffect } from 'react';
import { useStore, useToolStore } from '@ui/store';
import { isLocalMode } from '@ui/store/localMode';

export function useAutoFrame(): void {
  useEffect(
    () =>
      useStore.subscribe((state, previous) => {
        const becameNonEmpty =
          previous.document.order.length === 0 && state.document.order.length > 0;
        // Online, the camera is shared: framing would move every connected client's view.
        if (!becameNonEmpty || !isLocalMode(state)) return;
        const direction = useToolStore.getState().viewMode === '2d' ? 'current' : 'iso';
        state.dispatch('fit_view', { direction }, { quiet: true, coalesce: true });
      }),
    [],
  );
}
