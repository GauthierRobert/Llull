// View state of the PMI layer: whether the semantic PMI is drawn on its annotation planes. Presentation only (no document data).

import { create } from 'zustand';
import type { PmiItem, PmiModel } from '@core/model/pmi';

interface PmiViewState {
  showPmi: boolean;
  setShowPmi(show: boolean): void;
}

export const usePmiViewStore = create<PmiViewState>((set) => ({ showPmi: true, setShowPmi: (showPmi) => set({ showPmi }) }));

/** Items the viewport draws: those of the active saved view, else every item, in creation order. */
export function visiblePmiItems(pmi: PmiModel | undefined): PmiItem[] {
  if (pmi === undefined) return [];
  const active = pmi.activeSavedViewId === undefined ? undefined : pmi.savedViews[pmi.activeSavedViewId];
  const ids = active === undefined ? pmi.order : pmi.order.filter((id) => active.pmiIds.includes(id));
  return ids.flatMap((id) => {
    const item = pmi.items[id];
    return item === undefined ? [] : [item];
  });
}
