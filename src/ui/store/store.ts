/**
 * @layer ui/store
 *
 * Single Zustand store — the app's one source of truth.
 *
 * TWO MODES (both route every change through `execute(doc, name, params)`, PRIME DIRECTIVE)
 * ─────────
 * ONLINE (server-authoritative): the server owns the document. `dispatch` POSTs /command; the
 * /live command log arrives as `command` events re-run on `liveBase` through `execute`
 * (`applyLiveCommand`, hash-verified) or as `snapshot`s (`hydrateLiveDocument`). Undo/redo are
 * POST /undo and /redo; canUndo/canRedo come from responses.
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
 * RECONCILIATION (outbox). Every local mutating command is queued in `localOutbox` (offline undo
 * moves it to `localRedoOutbox`, redo back). On (re)connect the outbox is replayed to the server as
 * ordinary commands, in order (the server rebases them onto its log; each keeps its own undo
 * step), then the client adopts `GET /live/snapshot`; syncState is 'syncing' meanwhile. On failure
 * syncState='failed' and the flush retries with exponential backoff while the client stays local.
 * Live events received during a flush are superseded by the post-flush snapshot.
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
 *   - localOutbox / localRedoOutbox — offline commands awaiting replay on the server
 *   - liveBase / liveSeq — client copy of the server document at its log position
 */

import { create } from 'zustand';
import { createEmptyDocument } from '@core/model/types';
import type { CadDocument, EntityId } from '@core/model/types';
import {
  fetchLiveSnapshot,
  postCommand,
  postUndo,
  postRedo,
  ServerCommandError,
} from './serverCommands';
import { execute } from '@core/commands/registry';
import { remapIds } from '@core/commands/regenerate';
import type { LiveCommandEvent, LiveSnapshotEvent } from '@mcp/liveSync';
import { applyLiveCommand } from '@mcp/liveSync';

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

/** One locally executed mutating command awaiting replay on the server. */
export interface OutboxCommand {
  /** Client-generated idempotency key; the flush acks by this id and sends it as `commandId`. */
  readonly commandId: string;
  readonly name: string;
  readonly params: unknown;
  /** Ids the local run produced; zipped with the server's `affected` to remap later entries. */
  readonly affected: readonly string[];
}

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

  /**
   * Offline outbox: the local mutating commands, in order, that turned the last server
   * state into the current local document. Replayed to the server on reconnect.
   */
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
   * Used for: initial connect, undo/redo, resync after a log gap or hash mismatch.
   * Ignored while offline edits are still being replayed to the server.
   *
   * @pure  This is display sync, NOT a document mutation routed through execute().
   *        Allowed by the PRIME DIRECTIVE because it does not originate a CAD command.
   */
  hydrateLiveDocument(snapshot: LiveSnapshotEvent): void;

  /**
   * Apply one broadcast command by re-running it through `execute` on `liveBase` and
   * verifying the server's state hash. Unchanged entities keep their object references.
   *
   * @returns true for an already-applied event (same epoch, seq <= liveSeq); false on a log gap,
   *   a different server epoch, or hash mismatch — the caller then fetches a snapshot.
   * @pure  Display sync: the same command the server already applied, not a new CAD command.
   */
  applyLiveCommand(event: LiveCommandEvent): boolean;

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

/** Local id -> server id for ids minted differently while the entries were replayed (kept across retries). */
let flushIdMap = new Map<string, string>();

export function newCommandId(): string {
  const cryptoApi = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (typeof cryptoApi?.randomUUID === 'function') return cryptoApi.randomUUID();
  return `cmd-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/** History restore must not rewind the step counter, or undone ids would be re-minted. */
function withMonotonicStepCounter(restored: CadDocument, current: CadDocument): CadDocument {
  const nextStepNumber = Math.max(current.nextStepNumber ?? 1, restored.nextStepNumber ?? 1);
  return restored.nextStepNumber === nextStepNumber ? restored : { ...restored, nextStepNumber };
}

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

/** Offline undo moves the newest outbox command to the redo outbox; redo moves it back. */
function moveLastOutboxEntry(
  state: CadStoreState,
  direction: 'undo' | 'redo',
): Pick<CadStoreState, 'localOutbox' | 'localRedoOutbox'> {
  const from = direction === 'undo' ? state.localOutbox : state.localRedoOutbox;
  const moved = from[from.length - 1];
  if (moved === undefined) {
    return { localOutbox: state.localOutbox, localRedoOutbox: state.localRedoOutbox };
  }
  const rest = from.slice(0, -1);
  return direction === 'undo'
    ? { localOutbox: rest, localRedoOutbox: [...state.localRedoOutbox, moved] }
    : { localOutbox: [...state.localOutbox, moved], localRedoOutbox: rest };
}

/** Selection survives a document replacement, minus ids that no longer exist. */
function withLocalSelection(doc: CadDocument, selection: readonly EntityId[]): CadDocument {
  return { ...doc, selection: selection.filter((id) => id in doc.entities) };
}

function extendFlushIdMap(local: readonly string[], server: readonly string[]): void {
  const length = Math.min(local.length, server.length);
  for (let index = 0; index < length; index++) {
    const localId = local[index];
    const serverId = server[index];
    if (localId !== undefined && serverId !== undefined && localId !== serverId) {
      flushIdMap.set(localId, serverId);
    }
  }
}

/**
 * Offline -> online reconcile: replay the outbox to the server as ordinary commands, in
 * order (the server rebases them onto whatever happened meanwhile), then adopt the server
 * snapshot. Commands queued during the flush are sent too. Retries with backoff on failure.
 */
function flushOutbox(set: StoreSet, get: StoreGet): void {
  if (syncInFlight) return;
  cancelSyncRetry();
  syncInFlight = true;
  set({ syncState: 'syncing' });
  const sent: string[] = [];
  const sendNext = async (): Promise<void> => {
    for (;;) {
      const next = get().localOutbox[0];
      if (next === undefined) break;
      const response = await postCommand(
        next.name,
        remapIds(next.params, flushIdMap),
        next.commandId,
      );
      sent.push(response.summary);
      extendFlushIdMap(next.affected, response.affected);
      set((state) => ({
        localOutbox: state.localOutbox.filter((entry) => entry.commandId !== next.commandId),
      }));
    }
    const snapshot = await fetchLiveSnapshot();
    if (get().localOutbox.length > 0) return sendNext();
    const state = get();
    flushIdMap = new Map();
    set({
      hasUnsyncedLocalEdits: false,
      syncState: 'idle',
      localUndoStack: [],
      localRedoStack: [],
      localRedoOutbox: [],
      liveBase: snapshot.document,
      liveSeq: snapshot.seq,
      liveEpoch: snapshot.epoch,
      document: withLocalSelection(snapshot.document, state.document.selection),
      lastSummary: `Synced ${sent.length} offline command${sent.length === 1 ? '' : 's'} to the server.`,
    });
  };
  void sendNext()
    .then(() => {
      syncInFlight = false;
      syncAttempt = 0;
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
          flushOutbox(set, get);
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
    flushIdMap = new Map();
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
      cancelSyncRetry();
      syncAttempt = 0;
      if (!syncInFlight && get().syncState !== 'idle') set({ syncState: 'idle' });
    } else if (status === 'connected' && get().hasUnsyncedLocalEdits) {
      flushOutbox(set, get);
    }
  },
}));
