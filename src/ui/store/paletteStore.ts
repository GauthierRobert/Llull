/**
 * @layer ui/store
 *
 * Command palette store — open state, the most recently run palette items (persisted, so the
 * empty-query list starts with what the user reaches for) and the result toast of the last
 * command run from the palette. Presentation-only; never CadDocument.
 */

import { create } from 'zustand';
import { readStored, writeStored } from './persistence';

const STORAGE_KEY = 'llull-palette-recent';
const RECENT_LIMIT = 5;

function readRecent(): string[] {
  const stored = readStored(STORAGE_KEY);
  return Array.isArray(stored)
    ? stored.filter((id): id is string => typeof id === 'string').slice(0, RECENT_LIMIT)
    : [];
}

/** Outcome of a command run from the palette, shown as a toast. */
export interface PaletteResult {
  /** Increments per result, so a repeated identical summary is still a new toast. */
  id: number;
  commandName: string;
  summary: string;
  /** A mutating command that changed nothing (rejected / no-op). */
  failed: boolean;
}

interface PaletteStoreState {
  open: boolean;
  /** Palette item ids, most recent first, at most RECENT_LIMIT. */
  recentIds: readonly string[];
  result: PaletteResult | null;
  setOpen(open: boolean): void;
  showResult(result: Omit<PaletteResult, 'id'>): void;
  dismissResult(): void;
  /** Move `id` to the front of the recent list. */
  recordRecent(id: string): void;
}

export const usePaletteStore = create<PaletteStoreState>()((set, get) => ({
  open: false,
  recentIds: readRecent(),
  result: null,

  setOpen(open: boolean): void {
    set({ open });
  },

  showResult(result: Omit<PaletteResult, 'id'>): void {
    set({ result: { ...result, id: (get().result?.id ?? 0) + 1 } });
  },

  dismissResult(): void {
    set({ result: null });
  },

  recordRecent(id: string): void {
    const recentIds = [id, ...get().recentIds.filter((existing) => existing !== id)].slice(
      0,
      RECENT_LIMIT,
    );
    writeStored(STORAGE_KEY, recentIds);
    set({ recentIds });
  },
}));
