// GPU preview of implicit bodies (05 IMP 14.x), UI-only: the switch, and per body why it fell back to the mesh (the ops with no GPU path).

import { create } from 'zustand';

interface ImplicitPreviewState {
  enabled: boolean;
  /** Body id -> names that have no GPU path (empty list = drawn on the GPU). */
  fallbacks: Readonly<Record<string, readonly string[]>>;
  setEnabled(enabled: boolean): void;
  setFallback(id: string, unsupported: readonly string[]): void;
}

export const useImplicitPreviewStore = create<ImplicitPreviewState>()((set) => ({
  enabled: false,
  fallbacks: {},
  setEnabled: (enabled) => set({ enabled }),
  setFallback: (id, unsupported) =>
    set((state) => {
      const known = state.fallbacks[id];
      if (known !== undefined && known.length === unsupported.length && known.every((name, i) => name === unsupported[i])) return state;
      return { fallbacks: { ...state.fallbacks, [id]: unsupported } };
    }),
}));
