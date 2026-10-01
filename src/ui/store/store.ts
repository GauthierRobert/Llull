/**
 * @layer ui/store
 *
 * Single Zustand store — the app's one source of truth.
 *
 * TWO MODES (both route every change through `execute(doc, name, params)`, PRIME DIRECTIVE)
 * ─────────
 * ONLINE (server-authoritative): the server owns the document. `dispatch` POSTs /command and
 * the resulting document arrives over the /live SSE stream (`hydrateLiveDocument` /
 * `applyLivePatch`). Undo/redo are POST /undo and /redo; canUndo/canRedo come from responses.
 *
 * OFFLINE (local fallback, architecture L6): used when liveStatus is 'disconnected' OR a POST
 * fails with a NETWORK error (HTTP 4xx/5xx NEVER fall back — the server answered). dispatch runs
 * `execute(state.document, ...)` locally; undo/redo use a bounded local snapshot stack
 * (LOCAL_HISTORY_LIMIT). Local mutations set `hasUnsyncedLocalEdits`.
 *
 * RECONCILIATION POLICY
 *   - No unsynced edits: server wins — snapshots hydrate the store; local stacks are cleared.
 *   - Unsynced edits: CLIENT WINS — on the first snapshot after (re)connect the local document is
 *     pushed with POST /command `load_document` (serializeDocument); the server echo then
 *     hydrates the store. If the push fails the local doc is kept and the flag stays set.
 *
 * Local-only state (never sent to the server, never part of CadDocument):
 *   - selection              — which entity ids the user has clicked
 *   - renderOrigin           — floating-origin offset for three.js precision
 *   - liveStatus             — SSE connection health
 *   - lastSummary            — human-readable feedback from the last server response
 *   - lastMeasure            — structured result of the last read-only query command
 *   - canUndo / canRedo      — enabled-state for undo/redo UI (server responses or local stacks)
 *   - hasUnsyncedLocalEdits  — local edits not yet pushed to the server
 *   - localUndoStack / localRedoStack — offline snapshot history
 */

import { create } from 'zustand';
import { createEmptyDocument } from '@core/model/types';
import type { CadDocument, EntityId } from '@core/model/types';
import { postCommand, postUndo, postRedo, ServerCommandError } from './serverCommands';
import { execute } from '@core/commands/registry';
import { serializeDocument } from '@core/commands/persistence';
import type { DocPatch } from '@core/mcp/docPatch';
import { applyDocPatch } from '@core/mcp/docPatch';

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

  /** True when local (offline) edits exist that the server has not received. */
  hasUnsyncedLocalEdits: boolean;

  /** Offline undo snapshots, oldest first, bounded by LOCAL_HISTORY_LIMIT. */
  localUndoStack: CadDocument[];

  /** Offline redo snapshots, most recently undone last. */
  localRedoStack: CadDocument[];

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  /**
   * Send a named command to the server (POST /command).
   *
   * Fire-and-forget from the caller's perspective — returns void.
   * On success: updates lastSummary, lastMeasure (if data present), canUndo/canRedo.
   * On network failure: sets liveStatus to 'disconnected'; HTTP errors leave liveStatus alone. Always sets lastSummary to an error message.
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
   * Used for: initial connect, undo/redo (full state replacement).
   *
   * @pure  This is display sync, NOT a document mutation routed through execute().
   *        Allowed by the PRIME DIRECTIVE because it does not originate a CAD command.
   */
  hydrateLiveDocument(doc: CadDocument): void;

  /**
   * Apply an incremental entity-level patch from the server SSE stream.
   * Only touched entities are updated in the store; unchanged entities keep
   * their same object references so React does not re-render unaffected meshes.
   *
   * Preserves the current local selection (filters stale ids after the patch).
   *
   * Used for: every normal mutating command result (O(change) cost).
   *
   * @pure  Display sync only, not a CAD command.
   */
  applyLivePatch(patch: DocPatch): void;

  /**
   * Update the live SSE connection status.
   * Called by useMcpLiveDocument on EventSource lifecycle events.
   */
  setLiveStatus(status: 'connecting' | 'connected' | 'disconnected'): void;
}

// ---------------------------------------------------------------------------
// Store implementation
// ---------------------------------------------------------------------------

const LOCAL_HISTORY_LIMIT = 100;
const LOCAL_SUFFIX = ' (ran locally — offline)';

/** Guards against concurrent reconnect pushes. */
let syncInFlight = false;

function isNetworkError(err: unknown): boolean {
  return !(err instanceof ServerCommandError && err.kind === 'http');
}

function failureState(
  err: unknown,
  message: string,
): { lastSummary: string; liveStatus?: 'disconnected' } {
  return isNetworkError(err)
    ? { lastSummary: message, liveStatus: 'disconnected' }
    : { lastSummary: message };
}

type StoreSet = (
  partial: Partial<CadStoreState> | ((state: CadStoreState) => Partial<CadStoreState>),
) => void;
type StoreGet = () => CadStoreState;

/** Run a command locally via `execute` (offline mode). Pushes history only if the doc changed. */
function runLocally(set: StoreSet, get: StoreGet, name: string, params: unknown): void {
  const state = get();
  const result = execute(state.document, name, params);
  const summary = `${result.summary}${LOCAL_SUFFIX}`;
  const lastMeasure =
    result.data !== undefined ? { command: name, data: result.data } : state.lastMeasure;
  if (result.document === state.document) {
    set({ lastSummary: summary, lastMeasure });
    return;
  }
  const undoStack = [...state.localUndoStack, state.document].slice(-LOCAL_HISTORY_LIMIT);
  set({
    document: result.document,
    lastSummary: summary,
    lastMeasure,
    localUndoStack: undoStack,
    localRedoStack: [],
    canUndo: true,
    canRedo: false,
    hasUnsyncedLocalEdits: true,
  });
}

/** Step the local snapshot history (offline undo/redo). */
function stepLocalHistory(set: StoreSet, get: StoreGet, direction: 'undo' | 'redo'): void {
  const state = get();
  const source = direction === 'undo' ? state.localUndoStack : state.localRedoStack;
  const target = source[source.length - 1];
  if (target === undefined) {
    set({ lastSummary: `Nothing to ${direction}.${LOCAL_SUFFIX}` });
    return;
  }
  const remaining = source.slice(0, -1);
  const other = [
    ...(direction === 'undo' ? state.localRedoStack : state.localUndoStack),
    state.document,
  ];
  const undoStack = direction === 'undo' ? remaining : other.slice(-LOCAL_HISTORY_LIMIT);
  const redoStack = direction === 'undo' ? other : remaining;
  set({
    document: { ...target, selection: target.selection.filter((id) => id in target.entities) },
    localUndoStack: undoStack,
    localRedoStack: redoStack,
    canUndo: undoStack.length > 0,
    canRedo: redoStack.length > 0,
    hasUnsyncedLocalEdits: true,
    lastSummary: `${direction === 'undo' ? 'Undid' : 'Redid'} last step.${LOCAL_SUFFIX}`,
  });
}

/** Client-wins reconcile: push the local document via `load_document`; the server echo hydrates. */
function pushLocalDocument(set: StoreSet, get: StoreGet): void {
  if (syncInFlight) return;
  syncInFlight = true;
  const pushed = get().document;
  void postCommand('load_document', { json: serializeDocument(pushed) })
    .then((response) => {
      const stillSame = get().document === pushed;
      set({
        // Edits made during the push stay flagged so the next reconnect retries them.
        hasUnsyncedLocalEdits: !stillSame,
        localUndoStack: [],
        localRedoStack: [],
        canUndo: response.canUndo,
        canRedo: response.canRedo,
        lastSummary: `Synced offline edits to server. ${response.summary}`,
      });
    })
    .catch((err: unknown) => {
      set({
        lastSummary: `Could not sync offline edits: ${err instanceof Error ? err.message : String(err)}`,
      });
    })
    .finally(() => {
      syncInFlight = false;
    });
}

export const useStore = create<CadStoreState>()((set, get) => ({
  document: createEmptyDocument(),
  lastSummary: null,
  lastMeasure: null,
  canUndo: false,
  canRedo: false,
  renderOrigin: [0, 0, 0],
  liveStatus: 'connecting' as const,
  hasUnsyncedLocalEdits: false,
  localUndoStack: [],
  localRedoStack: [],

  dispatch(name: string, params?: unknown): void {
    if (get().liveStatus === 'disconnected') {
      runLocally(set, get, name, params);
      return;
    }
    // Fire-and-forget — the document update comes from the /live SSE stream.
    void postCommand(name, params)
      .then((response) => {
        set((state) => ({
          lastSummary: response.summary,
          canUndo: response.canUndo,
          canRedo: response.canRedo,
          // Only set lastMeasure when the response carries structured query data.
          // Mutating commands do not set data so lastMeasure is preserved as-is
          // (to keep measurement overlays until the user dismisses them).
          lastMeasure:
            response.data !== undefined
              ? { command: name, data: response.data }
              : state.lastMeasure,
        }));
      })
      .catch((err: unknown) => {
        if (isNetworkError(err)) {
          set({ liveStatus: 'disconnected' });
          runLocally(set, get, name, params);
          return;
        }
        const message =
          err instanceof ServerCommandError
            ? err.message
            : `Command '${name}' failed: ${String(err)}`;
        set(failureState(err, message));
      });
  },

  setDocument(doc: CadDocument): void {
    set({
      document: doc,
      lastSummary: null,
      canUndo: false,
      canRedo: false,
      localUndoStack: [],
      localRedoStack: [],
    });
  },

  undo(): void {
    if (get().liveStatus === 'disconnected') {
      stepLocalHistory(set, get, 'undo');
      return;
    }
    void postUndo()
      .then((response) => {
        set({
          lastSummary: response.summary,
          canUndo: response.canUndo,
          canRedo: response.canRedo,
        });
      })
      .catch((err: unknown) => {
        if (isNetworkError(err)) {
          set({ liveStatus: 'disconnected' });
          stepLocalHistory(set, get, 'undo');
          return;
        }
        const message =
          err instanceof ServerCommandError ? err.message : `Undo failed: ${String(err)}`;
        set(failureState(err, message));
      });
  },

  redo(): void {
    if (get().liveStatus === 'disconnected') {
      stepLocalHistory(set, get, 'redo');
      return;
    }
    void postRedo()
      .then((response) => {
        set({
          lastSummary: response.summary,
          canUndo: response.canUndo,
          canRedo: response.canRedo,
        });
      })
      .catch((err: unknown) => {
        if (isNetworkError(err)) {
          set({ liveStatus: 'disconnected' });
          stepLocalHistory(set, get, 'redo');
          return;
        }
        const message =
          err instanceof ServerCommandError ? err.message : `Redo failed: ${String(err)}`;
        set(failureState(err, message));
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
    if (get().hasUnsyncedLocalEdits) {
      pushLocalDocument(set, get);
      return;
    }
    const currentSelection = get().document.selection;
    // Preserve ids that still exist in the incoming doc; drop stale ones.
    const nextSelection = currentSelection.filter((id) => id in doc.entities);
    set({
      document: { ...doc, selection: nextSelection },
      localUndoStack: [],
      localRedoStack: [],
    });
  },

  applyLivePatch(patch: DocPatch): void {
    const state = get();
    if (state.hasUnsyncedLocalEdits) return;
    const next = applyDocPatch(state.document, patch);
    // Preserve selection: filter out any ids removed by the patch.
    const removedSet = new Set(patch.entities.removed);
    const nextSelection = state.document.selection.filter((id) => !removedSet.has(id));
    set({
      document: { ...next, selection: nextSelection },
    });
  },

  setLiveStatus(status: 'connecting' | 'connected' | 'disconnected'): void {
    set({ liveStatus: status });
  },
}));
