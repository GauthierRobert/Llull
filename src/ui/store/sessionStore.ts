/**
 * @layer ui/store
 *
 * Session store — presentation-only bookkeeping for autosave: whether the document changed since
 * the last explicit Save/Open/New, and whether the current content was restored from autosave.
 * Never part of CadDocument.
 */

import { create } from 'zustand';

interface SessionStoreState {
  /** True when the document changed since the last explicit Save / Open / New. */
  dirty: boolean;
  /** Epoch ms of the autosave that was restored at startup; null when nothing was restored. */
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
