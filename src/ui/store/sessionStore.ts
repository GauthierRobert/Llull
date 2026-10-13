// Autosave bookkeeping (UI-only): changed since the last Save/Open/New, and restored-from-autosave time.

import { create } from 'zustand';

interface SessionStoreState {
  dirty: boolean;
  /** Epoch ms of the restored autosave. */
  restoredAt: number | null;
  markDirty(): void;
  markSaved(): void;
  setRestoredAt(restoredAt: number | null): void;
}

export const useSessionStore = create<SessionStoreState>()((set) => ({
  dirty: false,
  restoredAt: null,
  markDirty: () => set({ dirty: true }),
  markSaved: () => set({ dirty: false }),
  setRestoredAt: (restoredAt) => set({ restoredAt }),
}));
