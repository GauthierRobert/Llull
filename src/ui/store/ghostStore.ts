// Solids drawn as a faint ghost (UI-only), per source: set while another rendering stands in for them or must be seen through them,
// e.g. the painted FEA result surface (analysis) or the members coloured by utilisation behind the cladding (structural).

import { create } from 'zustand';

interface GhostState {
  /** Union of every source's ids (what the renderer reads). */
  ghostedIds: ReadonlySet<string>;
  bySource: Readonly<Record<string, ReadonlySet<string>>>;
  setGhosted(source: string, ids: ReadonlySet<string>): void;
}

const NONE: ReadonlySet<string> = new Set();

export const useGhostStore = create<GhostState>()((set) => ({
  ghostedIds: NONE,
  bySource: {},
  setGhosted: (source, ids) =>
    set((state) => {
      const bySource = { ...state.bySource, [source]: ids };
      const union = new Set(Object.values(bySource).flatMap((members) => [...members]));
      return { bySource, ghostedIds: union.size === 0 ? NONE : union };
    }),
}));
