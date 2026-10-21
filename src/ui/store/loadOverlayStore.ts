// Which rigid-body loads the 3D view draws (UI-only, not persisted): the overlay on/off, per-layer and per-load hiding, value labels, and
// the load picked in the review list (drawn emphasised, the others dimmed).

import { create } from 'zustand';
import type { LoadLayer } from '@core/dynamics/dynamicsLoads';
import { toggledInList } from '@ui/toggleMember';

interface LoadOverlayState {
  shown: boolean;
  labels: boolean;
  hiddenLayers: readonly LoadLayer[];
  hiddenIds: readonly string[];
  focusedId: string | null;
  setShown(shown: boolean): void;
  setLabels(labels: boolean): void;
  toggleLayer(layer: LoadLayer): void;
  toggleLoad(id: string): void;
  focus(id: string | null): void;
}

export const useLoadOverlayStore = create<LoadOverlayState>()((set) => ({
  shown: true,
  labels: true,
  hiddenLayers: [],
  hiddenIds: [],
  focusedId: null,
  setShown: (shown) => set({ shown }),
  setLabels: (labels) => set({ labels }),
  toggleLayer: (layer) => set((state) => ({ hiddenLayers: toggledInList(state.hiddenLayers, layer) })),
  toggleLoad: (id) => set((state) => ({ hiddenIds: toggledInList(state.hiddenIds, id) })),
  focus: (focusedId) => set({ focusedId }),
}));

/** Whether the overlay draws `load` right now. */
export function isLoadDrawn(
  state: Pick<LoadOverlayState, 'shown' | 'hiddenLayers' | 'hiddenIds'>,
  load: { id: string; layer: LoadLayer },
): boolean {
  return state.shown && !state.hiddenLayers.includes(load.layer) && !state.hiddenIds.includes(load.id);
}
