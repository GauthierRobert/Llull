// Whether the 3D view draws the pipe-content markers (arrows along each run, letters on the lines whose rule has them). UI-only, not
// persisted. Toggled in the review Display section.

import { create } from 'zustand';

interface PipeMarkerState {
  shown: boolean;
  setShown(shown: boolean): void;
}

export const usePipeMarkerStore = create<PipeMarkerState>()((set) => ({ shown: true, setShown: (shown) => set({ shown }) }));
