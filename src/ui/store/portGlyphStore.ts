// Whether the 3D view draws the equipment nozzle port glyphs (UI-only, not persisted). Toggled in the equipment data-sheet section.

import { create } from 'zustand';

interface PortGlyphState {
  shown: boolean;
  setShown(shown: boolean): void;
}

export const usePortGlyphStore = create<PortGlyphState>()((set) => ({ shown: true, setShown: (shown) => set({ shown }) }));
