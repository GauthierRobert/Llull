// UI-only state of the P&ID 2D view (never a command, never in the document): the sheet drawn and the picked item.

import { create } from 'zustand';

export interface PidPick {
  readonly id: string;
  readonly kind: string;
}

interface PidViewState {
  /** Sheet id chosen in the picker; null = the first sheet of the model (also used when the chosen one was deleted). */
  activeSheetId: string | null;
  picked: PidPick | null;
  setActiveSheet(sheetId: string | null): void;
  setPicked(picked: PidPick | null): void;
}

export const usePidViewStore = create<PidViewState>()((set) => ({
  activeSheetId: null,
  picked: null,
  setActiveSheet: (activeSheetId) => set({ activeSheetId, picked: null }),
  setPicked: (picked) => set({ picked }),
}));
