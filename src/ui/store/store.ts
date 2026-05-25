/**
 * @layer ui/store
 *
 * Single Zustand store — the app's one source of truth.
 *
 * SERVER-AUTHORITATIVE MODEL
 * ─────────────────────────
 * The server owns the document. Every mutation goes to the server via `dispatch`
 * (POST /command), and the resulting document arrives back over the /live SSE stream
 * via `hydrateLiveDocument`. The store NEVER applies mutations locally — it only
 * reflects the server echo. This is fully consistent with the PRIME DIRECTIVE:
 * the UI gathers params and calls dispatch; it never builds or edits an Entity.
 *
 * Undo/redo history is managed server-side. The store tracks `canUndo`/`canRedo`
 * booleans returned by every server response; `undo()` and `redo()` are network
 * calls to POST /undo and POST /redo.
 *
 * Local-only state (never sent to the server, never part of CadDocument):
 *   - selection              — which entity ids the user has clicked
 *   - renderOrigin           — floating-origin offset for three.js precision
 *   - liveStatus             — SSE connection health
 *   - lastSummary            — human-readable feedback from the last server response
 *   - lastMeasure            — structured result of the last read-only query command
 *   - canUndo / canRedo      — enabled-state for undo/redo UI, from server responses
 */

import { create } from 'zustand';
import { createEmptyDocument } from '@core/model/types';
import type { CadDocument, EntityId } from '@core/model/types';
import { postCommand, postUndo, postRedo, ServerCommandError } from './serverCommands';

// ---------------------------------------------------------------------------
// State shape
// ---------------------------------------------------------------------------

/** The structured result of the most recently dispatched read-only/query command. */
export interface LastMeasure {
  /** The command name, e.g. 'measure_distance'. */
  command: string;
  /** The structured data returned by the command (typed per command, but stored as unknown here). */
  data: unknown;
}

export interface CadStoreState {
  /** The live CAD document — single source of truth, hydrated by the /live SSE stream. */
  document: CadDocument;

  /**
   * Floating-origin render offset — render-ONLY, NOT part of the document.
   * All entity mesh positions are expressed relative to this origin to keep
   * three.js float32 values small (avoids vertex jitter at large coordinates).
   * Updated by the 3D viewport when the camera target drifts beyond the rebase
   * threshold; never serialised into CadDocument.
   */
  renderOrigin: [number, number, number];

  /**
   * Summary returned by the most recent server response.
   * Handy for status bars and other command-feedback surfaces.
   * Null before any dispatch.
   */
  lastSummary: string | null;

  /**
   * Structured result of the most recent read-only/query command (one that
   * returned `response.data`). Replaced on every new measure dispatch; cleared
   * to null by `clearLastMeasure`. Mutating commands (those without `data`)
   * do NOT touch this field — so the last measurement stays visible until the
   * user explicitly dismisses it or runs a new measure.
   */
  lastMeasure: LastMeasure | null;

  /**
   * Whether the server reports that undo is available.
   * Updated from every /command, /undo, /redo response.
   */
  canUndo: boolean;

  /**
   * Whether the server reports that redo is available.
   * Updated from every /command, /undo, /redo response.
   */
  canRedo: boolean;

  /**
   * Live connection status to the server-side SSE document stream.
   * 'connecting' → EventSource opened, not yet confirmed.
   * 'connected'  → received first onopen / message.
   * 'disconnected' → EventSource errored; auto-reconnect pending.
   */
  liveStatus: 'connecting' | 'connected' | 'disconnected';

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  /**
   * Send a named command to the server (POST /command).
   *
   * Fire-and-forget from the caller's perspective — returns void.
   * On success: updates lastSummary, lastMeasure (if data present), canUndo/canRedo.
   * On failure: sets liveStatus to 'disconnected' and lastSummary to an error message.
   * The document is NEVER mutated here; it arrives via the /live SSE stream.
   *
   * This is the ONLY way the UI changes the document (PRIME DIRECTIVE).
   */
  dispatch(name: string, params?: unknown): void;

  /**
   * Replace the current document wholesale (load / reset).
   * Does NOT route through the server — use only for initial load or dev resets.
   */
  setDocument(doc: CadDocument): void;

  /**
   * Walk back one step in server-side history (POST /undo).
   * The reverted document arrives via the /live SSE stream.
   * Updates lastSummary and canUndo/canRedo from the server response.
   * No-op in the UI when canUndo is false.
   */
  undo(): void;

  /**
   * Walk forward one step in server-side history (POST /redo).
   * The re-applied document arrives via the /live SSE stream.
   * Updates lastSummary and canUndo/canRedo from the server response.
   * No-op in the UI when canRedo is false.
   */
  redo(): void;

  /**
   * Replace the current selection with `ids`.
   * Selection is local view state — updated synchronously, never sent to server.
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

  /**
   * Update the floating render origin.
   * Called by the 3D viewport when the camera target drifts beyond the rebase
   * threshold. This is a render-only concern and MUST NOT touch the document.
   */
  setRenderOrigin(origin: [number, number, number]): void;

  /**
   * Dismiss the last measurement result (clears `lastMeasure` to null).
   * Called by the MeasurementHUD dismiss button.
   */
  clearLastMeasure(): void;

  /**
   * Replace the document with a snapshot pushed by the server-side SSE stream.
   * Preserves the current local selection — filtered to entity ids that still
   * exist in the incoming document — so click-highlights survive a server push.
   *
   * @pure  This is display sync, NOT a document mutation routed through execute().
   *        Allowed by the PRIME DIRECTIVE because it does not originate a CAD command.
   */
  hydrateLiveDocument(doc: CadDocument): void;

  /**
   * Update the live SSE connection status.
   * Called by useMcpLiveDocument on EventSource lifecycle events.
   */
  setLiveStatus(status: 'connecting' | 'connected' | 'disconnected'): void;
}

// ---------------------------------------------------------------------------
// Store implementation
// ---------------------------------------------------------------------------

export const useStore = create<CadStoreState>()((set, get) => ({
  document: createEmptyDocument(),
  lastSummary: null,
  lastMeasure: null,
  canUndo: false,
  canRedo: false,
  renderOrigin: [0, 0, 0],
  liveStatus: 'connecting' as const,

  dispatch(name: string, params?: unknown): void {
    // Fire-and-forget — the document update comes from the /live SSE stream.
    void postCommand(name, params).then((response) => {
      set((state) => ({
        lastSummary: response.summary,
        canUndo: response.canUndo,
        canRedo: response.canRedo,
        // Only set lastMeasure when the response carries structured query data.
        // Mutating commands do not set data so lastMeasure is preserved as-is
        // (to keep measurement overlays until the user dismisses them).
        lastMeasure: response.data !== undefined
          ? { command: name, data: response.data }
          : state.lastMeasure,
      }));
    }).catch((err: unknown) => {
      const message = err instanceof ServerCommandError
        ? err.message
        : `Command '${name}' failed: ${String(err)}`;
      set({ liveStatus: 'disconnected', lastSummary: message });
    });
  },

  setDocument(doc: CadDocument): void {
    set({ document: doc, lastSummary: null, canUndo: false, canRedo: false });
  },

  undo(): void {
    void postUndo().then((response) => {
      set({
        lastSummary: response.summary,
        canUndo: response.canUndo,
        canRedo: response.canRedo,
      });
    }).catch((err: unknown) => {
      const message = err instanceof ServerCommandError
        ? err.message
        : `Undo failed: ${String(err)}`;
      set({ liveStatus: 'disconnected', lastSummary: message });
    });
  },

  redo(): void {
    void postRedo().then((response) => {
      set({
        lastSummary: response.summary,
        canUndo: response.canUndo,
        canRedo: response.canRedo,
      });
    }).catch((err: unknown) => {
      const message = err instanceof ServerCommandError
        ? err.message
        : `Redo failed: ${String(err)}`;
      set({ liveStatus: 'disconnected', lastSummary: message });
    });
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

  setRenderOrigin(origin: [number, number, number]): void {
    set({ renderOrigin: origin });
  },

  clearLastMeasure(): void {
    set({ lastMeasure: null });
  },

  hydrateLiveDocument(doc: CadDocument): void {
    const currentSelection = get().document.selection;
    // Preserve ids that still exist in the incoming doc; drop stale ones.
    const nextSelection = currentSelection.filter((id) => id in doc.entities);
    set({
      document: { ...doc, selection: nextSelection },
    });
  },

  setLiveStatus(status: 'connecting' | 'connected' | 'disconnected'): void {
    set({ liveStatus: status });
  },
}));
