// Health of the link to the local backend, UI-only (never the document): autosave failures reported by the backend (A-11),
// a live view that could not be resynchronised (TR-INT-16) and a backend that is restarting after a crash (A-10).

import { create } from 'zustand';
import type { LiveAutosaveStatus } from '@protocol/liveSync';

interface HostStatusState {
  autosave: LiveAutosaveStatus;
  /** Consecutive failed `/live/snapshot` resyncs reached the limit: what is shown may differ from the backend's document. */
  outOfSync: boolean;
  setAutosave(status: LiveAutosaveStatus): void;
  setOutOfSync(outOfSync: boolean): void;
}

export const useHostStatusStore = create<HostStatusState>()((set) => ({
  autosave: { ok: true },
  outOfSync: false,
  setAutosave: (autosave) => set({ autosave }),
  setOutOfSync: (outOfSync) => set({ outOfSync }),
}));
