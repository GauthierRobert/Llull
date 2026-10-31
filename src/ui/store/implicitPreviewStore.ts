// GPU preview of implicit bodies (05 IMP 14.x), UI-only: the switch, per body why it fell back to the mesh (the ops with no GPU path, a failed shader), and
// which bodies the GPU is drawing right now (their mesh is then not drawn).

import { create } from 'zustand';

interface ImplicitPreviewState {
  enabled: boolean;
  /** Body id -> names that have no GPU path (empty list = drawn on the GPU). */
  fallbacks: Readonly<Record<string, readonly string[]>>;
  /** Body ids drawn by the GPU preview (a true value per id); the mesh of such a body is hidden while the switch is on. */
  drawn: Readonly<Record<string, true>>;
  setEnabled(enabled: boolean): void;
  setFallback(id: string, unsupported: readonly string[]): void;
  /** Forget a body (deselected, deleted): no note, not drawn. */
  clearBody(id: string): void;
  setDrawn(id: string, drawn: boolean): void;
}

export const useImplicitPreviewStore = create<ImplicitPreviewState>()((set) => ({
  enabled: false,
  fallbacks: {},
  drawn: {},
  setEnabled: (enabled) => set({ enabled }),
  setFallback: (id, unsupported) =>
    set((state) => {
      const known = state.fallbacks[id];
      if (known !== undefined && known.length === unsupported.length && known.every((name, i) => name === unsupported[i])) return state;
      return { fallbacks: { ...state.fallbacks, [id]: unsupported } };
    }),
  clearBody: (id) =>
    set((state) => {
      if (!(id in state.fallbacks) && !(id in state.drawn)) return state;
      const { [id]: _note, ...fallbacks } = state.fallbacks;
      const { [id]: _drawn, ...drawn } = state.drawn;
      return { fallbacks, drawn };
    }),
  setDrawn: (id, isDrawn) =>
    set((state) => {
      if (id in state.drawn === isDrawn) return state;
      if (isDrawn) return { drawn: { ...state.drawn, [id]: true } };
      const { [id]: _gone, ...drawn } = state.drawn;
      return { drawn };
    }),
}));
