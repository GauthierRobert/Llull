// Solids drawn as a faint ghost (UI-only): set while another rendering stands in for them, e.g. the painted FEA result surface, so
// the undeformed part never hides the coloured, deformed one.

import { create } from 'zustand';

interface GhostState {
  ghostedIds: ReadonlySet<string>;
  setGhosted(ids: ReadonlySet<string>): void;
}

const NONE: ReadonlySet<string> = new Set();

export const useGhostStore = create<GhostState>()((set) => ({
  ghostedIds: NONE,
  setGhosted: (ghostedIds) => set({ ghostedIds: ghostedIds.size === 0 ? NONE : ghostedIds }),
}));
