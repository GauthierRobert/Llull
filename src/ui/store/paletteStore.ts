// Command palette UI state: open, persisted recents (the empty-query list), last result toast.

import { create } from 'zustand';
import { readStored, writeStored } from './persistence';

const STORAGE_KEY = 'llull-palette-recent';
const RECENT_LIMIT = 5;

function readRecent(): string[] {
  const stored = readStored(STORAGE_KEY);
  return Array.isArray(stored) ? stored.filter((id): id is string => typeof id === 'string').slice(0, RECENT_LIMIT) : [];
}

export interface PaletteResult {
  /** Per result, so a repeated summary is still a new toast. */
  id: number;
  commandName: string;
  summary: string;
  /** Mutating command that changed nothing. */
  failed: boolean;
}

interface PaletteStoreState {
  open: boolean;
  /** Command whose param form opens first; cleared on close. */
  pendingCommand: string | null;
  /** Most recent first, ≤ RECENT_LIMIT. */
  recentIds: readonly string[];
  result: PaletteResult | null;
  setOpen(open: boolean): void;
  /** Opens the palette straight on `name`'s param form. */
  openCommand(name: string): void;
  showResult(result: Omit<PaletteResult, 'id'>): void;
  dismissResult(): void;
  recordRecent(id: string): void;
}

export const usePaletteStore = create<PaletteStoreState>()((set, get) => ({
  open: false,
  pendingCommand: null,
  recentIds: readRecent(),
  result: null,

  setOpen(open: boolean): void {
    set(open ? { open } : { open, pendingCommand: null });
  },

  openCommand(name: string): void {
    set({ open: true, pendingCommand: name });
  },

  showResult(result: Omit<PaletteResult, 'id'>): void {
    set({ result: { ...result, id: (get().result?.id ?? 0) + 1 } });
  },

  dismissResult(): void {
    set({ result: null });
  },

  recordRecent(id: string): void {
    const recentIds = [id, ...get().recentIds.filter((existing) => existing !== id)].slice(0, RECENT_LIMIT);
    writeStored(STORAGE_KEY, recentIds);
    set({ recentIds });
  },
}));
