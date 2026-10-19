// Solids drawn in an override colour (UI-only), e.g. steel members coloured by their utilisation: the real geometry carries the
// verdict, so a diagonal brace reads exactly like the member it is.

import { create } from 'zustand';

interface TintState {
  tints: ReadonlyMap<string, string>;
  setTints(tints: ReadonlyMap<string, string>): void;
}

const NONE: ReadonlyMap<string, string> = new Map();

export const useTintStore = create<TintState>()((set) => ({
  tints: NONE,
  setTints: (tints) => set({ tints: tints.size === 0 ? NONE : tints }),
}));
