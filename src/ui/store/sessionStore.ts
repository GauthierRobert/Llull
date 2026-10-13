// Autosave bookkeeping (UI-only): changed since the last Save/Open/New, and restored-from-autosave time.

import { create } from 'zustand';

/** An unsaved autosave from a previous session that was NOT applied; the user decides (RestoredBanner). */
interface PendingLocalCopy {
  savedAt: number;
  json: string;
}

interface SessionStoreState {
  dirty: boolean;
  /** Epoch ms of the restored autosave. */
  restoredAt: number | null;
  pendingLocalCopy: PendingLocalCopy | null;
  markDirty(): void;
  setPendingLocalCopy(copy: PendingLocalCopy | null): void;
  markSaved(): void;
  setRestoredAt(restoredAt: number | null): void;
}

export const useSessionStore = create<SessionStoreState>()((set) => ({
  dirty: false,
  restoredAt: null,
  pendingLocalCopy: null,
  setPendingLocalCopy: (pendingLocalCopy) => set({ pendingLocalCopy }),
  markDirty: () => set({ dirty: true }),
  markSaved: () => set({ dirty: false }),
  setRestoredAt: (restoredAt) => set({ restoredAt }),
}));
