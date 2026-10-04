/**
 * @layer ui/store
 *
 * Command palette store — open state and the most recently run palette items (persisted, so the
 * empty-query list starts with what the user reaches for). Presentation-only; never CadDocument.
 */

import { create } from 'zustand';

const STORAGE_KEY = 'llull-palette-recent';
export const RECENT_LIMIT = 5;

function readRecent(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]');
    return Array.isArray(parsed)
      ? parsed.filter((id): id is string => typeof id === 'string').slice(0, RECENT_LIMIT)
      : [];
  } catch {
    return [];
  }
}

function persistRecent(recentIds: readonly string[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(recentIds));
  } catch {
    // localStorage unavailable (test env or sandboxed iframe)
  }
}

interface PaletteStoreState {
  open: boolean;
  /** Palette item ids, most recent first, at most RECENT_LIMIT. */
  recentIds: readonly string[];
  /** Command name run from the palette whose result summary has not been toasted yet. */
  awaitingResultOf: string | null;
  setOpen(open: boolean): void;
  setAwaitingResultOf(commandName: string | null): void;
  /** Move `id` to the front of the recent list. */
  recordRecent(id: string): void;
}

export const usePaletteStore = create<PaletteStoreState>()((set, get) => ({
  open: false,
  recentIds: readRecent(),
  awaitingResultOf: null,

  setOpen(open: boolean): void {
    set({ open });
  },

  setAwaitingResultOf(awaitingResultOf: string | null): void {
    set({ awaitingResultOf });
  },

  recordRecent(id: string): void {
    const recentIds = [id, ...get().recentIds.filter((existing) => existing !== id)].slice(
      0,
      RECENT_LIMIT,
    );
    persistRecent(recentIds);
    set({ recentIds });
  },
}));
