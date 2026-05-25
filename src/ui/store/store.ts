/**
 * @layer ui/store
 *
 * Single Zustand store — the app's one source of truth.
 *
 * All document mutations flow through `dispatch(name, params)` which routes to
 * `execute()` from the command registry. NO entity is ever built here; the store
 * only orchestrates (architecture L1, L4).
 *
 * Undo/redo: `dispatch` captures the prior document snapshot before running
 * `execute`. If the command actually changed the document (non-no-op), the prior
 * snapshot is pushed onto `undoStack` and `redoStack` is cleared. Commands that
 * return the same document reference (graceful no-ops) do NOT pollute the stack.
 * Stack depth is capped at MAX_UNDO_DEPTH to bound memory usage.
 *
 * `setDocument` (load / reset) clears both stacks — a freshly loaded document
 * has no history.
 */

import { create } from 'zustand';
import { createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import type { CadDocument, EntityId } from '@core/model/types';
import type { CommandResult } from '@core/commands/types';

/** Maximum number of snapshots retained per undo/redo stack. */
const MAX_UNDO_DEPTH = 100;

// ---------------------------------------------------------------------------
// State shape
// ---------------------------------------------------------------------------

export interface CadStoreState {
  /** The live CAD document — single source of truth. */
  document: CadDocument;

  /**
   * Summary returned by the most recent `dispatch` call.
   * Handy for status bars and other command-feedback surfaces.
   * Null before any dispatch.
   */
  lastSummary: string | null;

  /**
   * Prior document snapshots, oldest-first. Pop to undo.
   * Each entry is the full CadDocument returned by a previous dispatch —
   * no deep-clone is needed because commands are pure and never mutate prior
   * objects (architecture L3).
   */
  undoStack: CadDocument[];

  /**
   * Documents pushed when undoing, oldest-first. Pop to redo.
   * Cleared whenever a new command changes the document.
   */
  redoStack: CadDocument[];

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  /**
   * Route a command through the registry's `execute()`.
   * Returns the full `CommandResult` so callers can read `affected` and `summary`.
   * This is the ONLY way the UI changes the document (PRIME DIRECTIVE).
   *
   * Side-effect on history: if the command produces a new document (not a no-op),
   * the previous document is pushed onto `undoStack` and `redoStack` is cleared.
   *
   * @pure  The previous document is never mutated — `execute()` guarantees this.
   */
  dispatch(name: string, params: unknown): CommandResult;

  /**
   * Replace the current document wholesale (load / reset).
   * Does NOT route through `execute()` — use only for whole-document replacement.
   * Clears both `undoStack` and `redoStack` because the prior history no longer
   * applies to the new document.
   */
  setDocument(doc: CadDocument): void;

  /**
   * Walk back one step in history. Pushes the current document onto `redoStack`
   * and replaces it with the top of `undoStack`. No-op when `undoStack` is empty.
   */
  undo(): void;

  /**
   * Walk forward one step in history. Pushes the current document onto `undoStack`
   * and replaces it with the top of `redoStack`. No-op when `redoStack` is empty.
   */
  redo(): void;

  /**
   * Replace the current selection with `ids`.
   * Selection is view state on the document — updated with an immutable spread.
   */
  select(ids: EntityId[]): void;

  /**
   * Toggle a single entity in/out of selection.
   */
  toggleSelection(id: EntityId): void;

  /**
   * Clear all selected entities.
   */
  clearSelection(): void;
}

// ---------------------------------------------------------------------------
// Store implementation
// ---------------------------------------------------------------------------

export const useStore = create<CadStoreState>()((set, get) => ({
  document: createEmptyDocument(),
  lastSummary: null,
  undoStack: [],
  redoStack: [],

  dispatch(name: string, params: unknown): CommandResult {
    const prior = get().document;
    const result = execute(prior, name, params);

    if (result.document !== prior) {
      // Command produced a new document — record history.
      set((state) => ({
        document: result.document,
        lastSummary: result.summary,
        undoStack: [...state.undoStack, prior].slice(-MAX_UNDO_DEPTH),
        redoStack: [],
      }));
    } else {
      // Graceful no-op — do NOT push history, just update summary.
      set({ lastSummary: result.summary });
    }

    return result;
  },

  setDocument(doc: CadDocument): void {
    set({ document: doc, lastSummary: null, undoStack: [], redoStack: [] });
  },

  undo(): void {
    const { undoStack, document } = get();
    if (undoStack.length === 0) return;

    const previous = undoStack[undoStack.length - 1]!;
    set((state) => ({
      document: previous,
      undoStack: state.undoStack.slice(0, -1),
      redoStack: [...state.redoStack, document].slice(-MAX_UNDO_DEPTH),
    }));
  },

  redo(): void {
    const { redoStack, document } = get();
    if (redoStack.length === 0) return;

    const next = redoStack[redoStack.length - 1]!;
    set((state) => ({
      document: next,
      redoStack: state.redoStack.slice(0, -1),
      undoStack: [...state.undoStack, document].slice(-MAX_UNDO_DEPTH),
    }));
  },

  select(ids: EntityId[]): void {
    set((state) => ({
      document: { ...state.document, selection: [...ids] },
    }));
  },

  toggleSelection(id: EntityId): void {
    set((state) => {
      const current = state.document.selection;
      const next = current.includes(id)
        ? current.filter((existingId) => existingId !== id)
        : [...current, id];
      return { document: { ...state.document, selection: next } };
    });
  },

  clearSelection(): void {
    set((state) => ({
      document: { ...state.document, selection: [] },
    }));
  },
}));
