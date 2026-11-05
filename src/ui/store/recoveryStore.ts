// Recovery slots the backend holds for documents that were open when llull stopped, and offline edits kept on reconnect (A-08, FR-DSF-23).
// UI-only state: the slots live in the backend; restoring one is the `load_document` command followed by an adopt call.

import { create } from 'zustand';
import { fetchRecoverySlots, type RecoverySlotInfo } from './serverCommands';

interface RecoveryState {
  /** Slots of other sessions or kept offline edits; the open document's own slot is not offered. */
  slots: RecoverySlotInfo[];
  /** The Document Recovery dialog is showing. */
  open: boolean;
  /** Edits made while the backend was unreachable were saved as a recoverable copy. */
  offlineEditsKept: boolean;
  /** The file the backend's document belongs to (SSE `document`); null: untitled / not announced. Offline edits are filed under it. */
  documentPath: string | null;
  setDocumentPath(path: string | null): void;
  /** Ask the backend; open the dialog when there is something to recover (`reveal`). Resolves false when the backend cannot answer. */
  refresh(reveal: boolean): Promise<boolean>;
  setOpen(open: boolean): void;
  remove(id: string): void;
  setOfflineEditsKept(kept: boolean): void;
}

export const useRecoveryStore = create<RecoveryState>()((set, get) => ({
  slots: [],
  open: false,
  offlineEditsKept: false,
  documentPath: null,
  setDocumentPath: (documentPath) => set({ documentPath }),
  async refresh(reveal) {
    try {
      const { slots } = await fetchRecoverySlots();
      const offered = slots.filter((slot) => !slot.active);
      set({ slots: offered, open: reveal ? offered.length > 0 : get().open && offered.length > 0 });
      return true;
    } catch {
      return false;
    }
  },
  setOpen: (open) => set({ open }),
  remove(id) {
    const slots = get().slots.filter((slot) => slot.id !== id);
    set({
      slots,
      open: get().open && slots.length > 0,
      offlineEditsKept: get().offlineEditsKept && slots.some((slot) => slot.kind === 'offline'),
    });
  },
  setOfflineEditsKept: (offlineEditsKept) => set({ offlineEditsKept }),
}));
