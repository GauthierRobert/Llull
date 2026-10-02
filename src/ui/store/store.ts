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
 * LOCAL MODE (offline fallback, architecture L6): dispatch/undo/redo run locally (`execute` +
 * bounded snapshot stack, LOCAL_HISTORY_LIMIT) when ANY of:
 *   - liveStatus is 'disconnected' (SSE down); or a POST fails with a network error while
 *     'connecting' and no SSE has ever connected (first dispatch races the first connect);
 *   - syncState is not 'idle' (an offline->online push is pending, in flight, or failed);
 *   - hasUnsyncedLocalEdits (local edits the server has not received).
 * Connectivity is decided ONLY by the SSE hook (`setLiveStatus`). A POST network error while the
 * SSE stream is open NEVER goes local (the command may have executed server-side -> duplicate) and
 * never changes liveStatus: lastSummary reports "not applied — network error, retry". HTTP 4xx/5xx
 * never fall back either.
 *
 * RECONCILIATION (client wins). Every local mutation increments `localEditCounter`. On (re)connect
 * the local doc is pushed via POST /command `load_document`; syncState 'syncing'. On success the
 * unsynced flag clears only if the counter still equals the value captured at push start,
 * otherwise the push repeats. On failure syncState='failed' and the push retries with exponential
 * backoff while the client stays in local mode. Server patches/snapshots are never dropped while
 * connected: patches always apply; snapshots hydrate only when there are no unsynced edits.
 * A sync is recorded on the server as ONE `load_document` undo step that reverts ALL offline
 * edits at once.
 *
 * Local-only state (never sent to the server, never part of CadDocument):
 *   - selection              — which entity ids the user has clicked
 *   - renderOrigin           — floating-origin offset for three.js precision
 *   - liveStatus             — SSE connection health
 *   - lastSummary            — human-readable feedback from the last server response
 *   - lastMeasure            — structured result of the last read-only query command
 *   - canUndo / canRedo      — enabled-state for undo/redo UI (server responses or local stacks)
 *   - hasUnsyncedLocalEdits / localEditCounter / syncState / sseEverConnected — sync bookkeeping
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

export type SyncState = 'idle' | 'syncing' | 'failed';

export interface DispatchOptions {
  /** Replace the selection with the command's `affected` ids when it succeeds with any. */
  selectAffected?: boolean;
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

  /** Monotonic count of local command executions / local undo-redo steps. Selection never bumps it. */
  localEditCounter: number;

  /** Offline->online push: 'idle' none, 'syncing' push pending/in flight, 'failed' awaiting retry. */
  syncState: SyncState;

  /** True once the SSE stream has opened at least once (distinguishes first connect from reconnect). */
  sseEverConnected: boolean;

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
   * On network error with SSE open: not applied, lastSummary says so. In local mode: runs locally.
   * The document is NEVER mutated here; it arrives via the /live SSE stream.
   *
   * This is the ONLY way the UI changes the document (PRIME DIRECTIVE).
   */
  dispatch(name: string, params?: unknown, options?: DispatchOptions): void;

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

const SYNC_RETRY_BASE_MS = 1000;
const SYNC_RETRY_MAX_MS = 30000;

/** Guards against concurrent pushes. */
let syncInFlight = false;
let syncRetryTimer: ReturnType<typeof setTimeout> | null = null;
let syncAttempt = 0;

function cancelSyncRetry(): void {
  if (syncRetryTimer !== null) clearTimeout(syncRetryTimer);
  syncRetryTimer = null;
}

function isNetworkError(err: unknown): boolean {
  return !(err instanceof ServerCommandError && err.kind === 'http');
}

/** Commands must run locally (never POST) in this state. */
function isLocalMode(state: CadStoreState): boolean {
  return (
    state.liveStatus === 'disconnected' || state.syncState !== 'idle' || state.hasUnsyncedLocalEdits
  );
}

/** True when a failed POST means "server never reachable": safe to run locally. */
function sseIsDown(state: CadStoreState): boolean {
  return (
    state.liveStatus === 'disconnected' ||
    (state.liveStatus === 'connecting' && !state.sseEverConnected)
  );
}

function postFailureMessage(err: unknown, what: string): string {
  if (err instanceof ServerCommandError && err.kind === 'http') return err.message;
  if (isNetworkError(err) && err instanceof ServerCommandError) {
    return `${what} not applied — network error, retry.`;
  }
  return `${what} failed: ${String(err)}`;
}

/** Handle a failed POST: local fallback only when SSE is down; otherwise surface the error. */
function handlePostFailure(
  set: StoreSet,
  get: StoreGet,
  err: unknown,
  what: string,
  runLocal: () => void,
): void {
  if (isNetworkError(err) && sseIsDown(get())) {
    set({ liveStatus: 'disconnected' });
    runLocal();
    return;
  }
  set({ lastSummary: postFailureMessage(err, what) });
}

type StoreSet = (
  partial: Partial<CadStoreState> | ((state: CadStoreState) => Partial<CadStoreState>),
) => void;
type StoreGet = () => CadStoreState;

/** Selection after a command: its affected ids when requested and non-empty, else unchanged. */
function selectionAfter(
  current: EntityId[],
  affected: readonly EntityId[],
  options: DispatchOptions | undefined,
): EntityId[] {
  return options?.selectAffected === true && affected.length > 0 ? [...affected] : current;
}

/**
 * Server path: the affected entities may arrive over SSE after this response, so the selection is
 * taken as-is (snapshot hydration later filters any id that never materialised). If the user
 * changed the selection while the request was in flight, their newer selection wins.
 */
function selectAffectedIn(
  doc: CadDocument,
  selectionAtDispatch: readonly EntityId[],
  affected: readonly EntityId[],
  options: DispatchOptions | undefined,
): CadDocument {
  const unchanged =
    doc.selection.length === selectionAtDispatch.length &&
    doc.selection.every((id, index) => id === selectionAtDispatch[index]);
  if (!unchanged) return doc;
  const selection = selectionAfter(doc.selection, affected, options);
  return selection === doc.selection ? doc : { ...doc, selection };
}

/** Run a command locally via `execute` (offline mode). Pushes history only if the doc changed. */
function runLocally(
  set: StoreSet,
  get: StoreGet,
  name: string,
  params: unknown,
  options?: DispatchOptions,
): void {
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
    document: {
      ...result.document,
      selection: selectionAfter(result.document.selection, result.affected, options),
    },
    lastSummary: summary,
    lastMeasure,
    localUndoStack: undoStack,
    localRedoStack: [],
    canUndo: true,
    canRedo: false,
    hasUnsyncedLocalEdits: true,
    localEditCounter: state.localEditCounter + 1,
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
    localEditCounter: state.localEditCounter + 1,
    lastSummary: `${direction === 'undo' ? 'Undid' : 'Redid'} last step.${LOCAL_SUFFIX}`,
  });
}

/**
 * Client-wins reconcile: push the local document via `load_document`. Repeats until the counter
 * captured at push start equals the current counter; retries with backoff on failure.
 */
function pushLocalDocument(set: StoreSet, get: StoreGet): void {
  if (syncInFlight) return;
  cancelSyncRetry();
  syncInFlight = true;
  const pushed = get().document;
  const capturedCounter = get().localEditCounter;
  set({ syncState: 'syncing' });
  void postCommand('load_document', { json: serializeDocument(pushed) })
    .then((response) => {
      syncInFlight = false;
      syncAttempt = 0;
      if (get().localEditCounter !== capturedCounter) {
        pushLocalDocument(set, get);
        return;
      }
      set({
        hasUnsyncedLocalEdits: false,
        syncState: 'idle',
        localUndoStack: [],
        localRedoStack: [],
        canUndo: response.canUndo,
        canRedo: response.canRedo,
        lastSummary: `Synced offline edits to server. ${response.summary}`,
      });
    })
    .catch((err: unknown) => {
      syncInFlight = false;
      set({
        syncState: 'failed',
        lastSummary: `Could not sync offline edits (will retry): ${err instanceof Error ? err.message : String(err)}`,
      });
      if (get().liveStatus === 'disconnected') return;
      const delay = Math.min(SYNC_RETRY_BASE_MS * 2 ** syncAttempt, SYNC_RETRY_MAX_MS);
      syncAttempt += 1;
      syncRetryTimer = setTimeout(() => {
        syncRetryTimer = null;
        const state = get();
        if (state.hasUnsyncedLocalEdits && state.liveStatus !== 'disconnected') {
          pushLocalDocument(set, get);
        }
      }, delay);
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
  localEditCounter: 0,
  syncState: 'idle' as const,
  sseEverConnected: false,
  localUndoStack: [],
  localRedoStack: [],

  dispatch(name: string, params?: unknown, options?: DispatchOptions): void {
    if (isLocalMode(get())) {
      runLocally(set, get, name, params, options);
      return;
    }
    // Fire-and-forget — the document update comes from the /live SSE stream.
    const selectionAtDispatch = get().document.selection;
    void postCommand(name, params)
      .then((response) => {
        set((state) => ({
          document: selectAffectedIn(
            state.document,
            selectionAtDispatch,
            response.affected,
            options,
          ),
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
        handlePostFailure(set, get, err, `Command '${name}'`, () =>
          runLocally(set, get, name, params, options),
        );
      });
  },

  setDocument(doc: CadDocument): void {
    cancelSyncRetry();
    syncAttempt = 0;
    set({
      hasUnsyncedLocalEdits: false,
      localEditCounter: 0,
      syncState: 'idle',
      document: doc,
      lastSummary: null,
      canUndo: false,
      canRedo: false,
      localUndoStack: [],
      localRedoStack: [],
    });
  },

  undo(): void {
    if (isLocalMode(get())) {
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
        handlePostFailure(set, get, err, 'Undo', () => stepLocalHistory(set, get, 'undo'));
      });
  },

  redo(): void {
    if (isLocalMode(get())) {
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
        handlePostFailure(set, get, err, 'Redo', () => stepLocalHistory(set, get, 'redo'));
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
    const next = applyDocPatch(state.document, patch);
    // Preserve selection: filter out any ids removed by the patch.
    const removedSet = new Set(patch.entities.removed);
    const nextSelection = state.document.selection.filter((id) => !removedSet.has(id));
    set({
      document: { ...next, selection: nextSelection },
    });
  },

  setLiveStatus(status: 'connecting' | 'connected' | 'disconnected'): void {
    set(
      status === 'connected'
        ? { liveStatus: status, sseEverConnected: true }
        : { liveStatus: status },
    );
    if (status === 'disconnected') {
      cancelSyncRetry();
      syncAttempt = 0;
      if (!syncInFlight && get().syncState !== 'idle') set({ syncState: 'idle' });
    } else if (status === 'connected' && get().hasUnsyncedLocalEdits) {
      pushLocalDocument(set, get);
    }
  },
}));
