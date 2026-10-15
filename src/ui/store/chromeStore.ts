// On-demand chrome (UI-only, not persisted): whether the 3D view options (display mode, section, quality, view presets)
// are shown over the viewport.

import { create } from 'zustand';

interface ChromeState {
  viewOptionsOpen: boolean;
  toggleViewOptions(): void;
}

export const useChromeStore = create<ChromeState>()((set) => ({
  viewOptionsOpen: false,
  toggleViewOptions: () => set((state) => ({ viewOptionsOpen: !state.viewOptionsOpen })),
}));
