// In-Canvas: `invalidate()` on watched store changes (demand frameloop), subscribed outside React; pure commands make
// reference equality a sufficient change test.

import { useEffect } from 'react';
import { useThree } from '@react-three/fiber';
import type { StoreApi } from 'zustand';
import { useStore, useViewportStore } from '@ui/store';

function useInvalidateOnChange<T>(store: Pick<StoreApi<T>, 'subscribe'>, changed: (state: T, previous: T) => boolean): void {
  const invalidate = useThree((s) => s.invalidate);
  useEffect(
    () =>
      store.subscribe((state, previous) => {
        if (changed(state, previous)) invalidate();
      }),
    [store, changed, invalidate],
  );
}

const documentChanged = (state: ReturnType<typeof useStore.getState>, previous: ReturnType<typeof useStore.getState>): boolean =>
  state.document !== previous.document || state.renderOrigin !== previous.renderOrigin;

/** Repaints when the CAD document or renderOrigin change. */
export function StoreInvalidator(): null {
  useInvalidateOnChange(useStore, documentChanged);
  return null;
}

const viewportChanged = (
  state: ReturnType<typeof useViewportStore.getState>,
  previous: ReturnType<typeof useViewportStore.getState>,
): boolean =>
  state.displayMode !== previous.displayMode ||
  state.clipPlane !== previous.clipPlane ||
  state.hiddenEntityIds !== previous.hiddenEntityIds ||
  state.qualityOverride !== previous.qualityOverride;

/** Repaints when displayMode, clipPlane, hiddenEntityIds or qualityOverride change. */
export function ViewportStoreInvalidator(): null {
  useInvalidateOnChange(useViewportStore, viewportChanged);
  return null;
}
