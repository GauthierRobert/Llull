/**
 * @layer ui/store
 * Single Zustand store (the app's one source of truth). Every change goes through
 * `execute(doc, name, params)`.
 * - ONLINE: `dispatch` POSTs /command; /live events are re-run on `liveBase` (`applyLiveCommand`)
 *   or adopted as snapshots (`hydrateLiveDocument`). Undo/redo POST /undo and /redo.
 * - LOCAL MODE (offline, L6): when liveStatus is 'disconnected', syncState is not 'idle', or
 *   hasUnsyncedLocalEdits, commands run locally with a bounded snapshot stack and are queued in
 *   `localOutbox` for replay (`./outbox`). A POST network error while SSE is open never goes
 *   local (the command may have executed server-side); HTTP 4xx/5xx never fall back either.
 * Connectivity is decided ONLY by the SSE hook (`setLiveStatus`).
 */

import { create } from 'zustand';
import { createEmptyDocument } from '@core/model/types';
import type { CadDocument, EntityId } from '@core/model/types';
import { postCommand, postUndo, postRedo, ServerCommandError } from './serverCommands';
import {
  flushOutbox,
  moveLastOutboxEntry,
  newCommandId,
  onSseDisconnected,
  resetSyncBookkeeping,
  withLocalSelection,
} from './outbox';
import type { OutboxCommand, StoreGet, StoreSet } from './outbox';
import { execute } from '@core/commands/registry';
import type { LiveCommandEvent, LiveSnapshotEvent } from '@mcp/liveSync';
import { applyLiveCommand } from '@mcp/liveSync';

// ---------------------------------------------------------------------------
// State shape
// ---------------------------------------------------------------------------

/** The structured result of the most recently dispatched read-only/query command. */
interface LastMeasure {
  /** The command name, e.g. 'measure_distance'. */
  command: string;
  /** The structured data returned by the command (typed per command, but stored as unknown here). */
  data: unknown;
}

type SyncState = 'idle' | 'syncing' | 'failed';

interface DispatchOptions {
  /** Replace the selection with the command's `affected` ids when it succeeds with any. */
  selectAffected?: boolean;
}

export interface CadStoreState {
  /** The live CAD document — single source of truth, hydrated by the /live SSE stream. */
  document: CadDocument;

  /** Floating-origin render offset — render-ONLY, NOT part of the document. */
  renderOrigin: [number, number, number];

  /** Summary returned by the most recent server response. */
  lastSummary: string | null;

  /** Structured result of the most recent read-only/query command (one that returned `response.data`). */
  lastMeasure: LastMeasure | null;

  /** Whether the server reports that undo is available. */
  canUndo: boolean;

  /** Whether the server reports that redo is available. */
  canRedo: boolean;

  /** Live connection status to the server-side SSE document stream. */
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

  /** Offline outbox: the local mutating commands, in order, that turned the last server state into the current local document. */
  localOutbox: OutboxCommand[];

  /** Outbox entries undone offline (most recently undone last); re-queued by local redo. */
  localRedoOutbox: OutboxCommand[];

  /** Client copy of the server document (server selection) at log position `liveSeq`. */
  liveBase: CadDocument;

  /** Log position of `liveBase`; -1 before the first snapshot. */
  liveSeq: number;

  /** Server process epoch of `liveSeq` (null before the first snapshot); seq compares only within one epoch. */
  liveEpoch: string | null;

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  /** Send a named command to the server (POST /command). */
  dispatch(name: string, params?: unknown, options?: DispatchOptions): void;

  /** Replace the current document wholesale (load / reset). */
  setDocument(doc: CadDocument): void;

  /** Walk back one step in server-side history (POST /undo). */
  undo(): void;

  /** Walk forward one step in server-side history (POST /redo). */
  redo(): void;

  /** Replace the current selection with `ids`. */
  select(ids: EntityId[]): void;

  /** Toggle a single entity in/out of selection. */
  toggleSelection(id: EntityId): void;

  /** Clear all selected entities. */
  clearSelection(): void;

  /** Update the floating render origin. */
  setRenderOrigin(origin: [number, number, number]): void;

  /** Dismiss the last measurement result (clears `lastMeasure` to null). */
  clearLastMeasure(): void;

  /** Replace the document with a snapshot pushed by the server-side SSE stream. */
  hydrateLiveDocument(snapshot: LiveSnapshotEvent): void;

  /** Apply one broadcast command by re-running it through `execute` on `liveBase` and verifying the server's state hash. */
  applyLiveCommand(event: LiveCommandEvent): boolean;

  /** Update the live SSE connection status. */
  setLiveStatus(status: 'connecting' | 'connected' | 'disconnected'): void;
}

// ---------------------------------------------------------------------------
// Store implementation
// ---------------------------------------------------------------------------

const LOCAL_HISTORY_LIMIT = 100;
const LOCAL_SUFFIX = ' (ran locally — offline)';

/** History restore must not rewind the step counter, or undone ids would be re-minted. */
function withMonotonicStepCounter(restored: CadDocument, current: CadDocument): CadDocument {
  const nextStepNumber = Math.max(current.nextStepNumber ?? 1, restored.nextStepNumber ?? 1);
  return restored.nextStepNumber === nextStepNumber ? restored : { ...restored, nextStepNumber };
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

/** Local undo/redo would move the in-flight outbox entry; refuse until the flush finishes. */
function refuseDuringSync(set: StoreSet, get: StoreGet): boolean {
  if (get().syncState === 'idle') return false;
  set({ lastSummary: 'Sync in progress — undo/redo after it finishes.' });
  return true;
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
    localOutbox: [
      ...state.localOutbox,
      { commandId: newCommandId(), name, params, affected: result.affected },
    ],
    localRedoOutbox: [],
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
  const outbox = moveLastOutboxEntry(state, direction);
  set({
    ...outbox,
    document: {
      ...withMonotonicStepCounter(target, state.document),
      selection: target.selection.filter((id) => id in target.entities),
    },
    localUndoStack: undoStack,
    localRedoStack: redoStack,
    canUndo: undoStack.length > 0,
    canRedo: redoStack.length > 0,
    hasUnsyncedLocalEdits: true,
    localEditCounter: state.localEditCounter + 1,
    lastSummary: `${direction === 'undo' ? 'Undid' : 'Redid'} last step.${LOCAL_SUFFIX}`,
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
  localOutbox: [],
  localRedoOutbox: [],
  liveBase: createEmptyDocument(),
  liveSeq: -1,
  liveEpoch: null,

  dispatch(name: string, params?: unknown, options?: DispatchOptions): void {
    if (isLocalMode(get())) {
      runLocally(set, get, name, params, options);
      return;
    }
    // Fire-and-forget — the document update comes from the /live SSE stream.
    const selectionAtDispatch = get().document.selection;
    void postCommand(name, params, newCommandId())
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
    resetSyncBookkeeping();
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
      localOutbox: [],
      localRedoOutbox: [],
    });
  },

  undo(): void {
    if (refuseDuringSync(set, get)) return;
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
    if (refuseDuringSync(set, get)) return;
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

  hydrateLiveDocument(snapshot: LiveSnapshotEvent): void {
    if (get().hasUnsyncedLocalEdits) {
      flushOutbox(set, get);
      return;
    }
    const { liveEpoch, liveSeq } = get();
    if (snapshot.epoch === liveEpoch && snapshot.seq < liveSeq) return; // stale resync response
    set({
      liveBase: snapshot.document,
      liveSeq: snapshot.seq,
      liveEpoch: snapshot.epoch,
      document: withLocalSelection(snapshot.document, get().document.selection),
      localUndoStack: [],
      localRedoStack: [],
    });
  },

  applyLiveCommand(event: LiveCommandEvent): boolean {
    const state = get();
    if (state.hasUnsyncedLocalEdits) return true; // the post-flush snapshot supersedes it
    if (event.epoch === state.liveEpoch && event.seq <= state.liveSeq) return true; // already applied
    if (event.epoch !== state.liveEpoch) return false; // server restarted (or no snapshot yet)
    const applied = applyLiveCommand(state.liveBase, state.liveSeq, event);
    if (!applied.ok) return false;
    set({
      liveBase: applied.document,
      liveSeq: event.seq,
      document: withLocalSelection(applied.document, state.document.selection),
    });
    return true;
  },

  setLiveStatus(status: 'connecting' | 'connected' | 'disconnected'): void {
    set(
      status === 'connected'
        ? { liveStatus: status, sseEverConnected: true }
        : { liveStatus: status },
    );
    if (status === 'disconnected') {
      onSseDisconnected(set, get);
    } else if (status === 'connected' && get().hasUnsyncedLocalEdits) {
      flushOutbox(set, get);
    }
  },
}));
