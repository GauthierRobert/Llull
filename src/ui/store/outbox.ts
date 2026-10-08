/**
 * @layer ui/store
 * Offline outbox: queued local commands, their replay to the server on reconnect, and the
 * sync retry/backoff bookkeeping. On failure syncState='failed' and the flush retries with
 * exponential backoff. Live events received during a flush are superseded by the post-flush snapshot.
 */

import type { CadDocument, EntityId } from '@core/model/types';
import { extendIdMap, mapStringLeaves, remapIds } from '@core/commands/regenerate';
import { errorMessage } from '@lib/errorMessage';
import {
  fetchLiveSnapshot,
  isCommandRefusal,
  isConnectionRefusal,
  postCommand,
} from './serverCommands';
import type { CadStoreState, StoreGet, StoreSet } from './storeTypes';
import { resetGraceRuns } from './graceRuns';

const SYNC_RETRY_BASE_MS = 1000;
const SYNC_RETRY_MAX_MS = 30000;

/** One locally executed mutating command awaiting replay on the server. */
export interface OutboxCommand {
  /** Client-generated idempotency key; the flush acks by this id and sends it as `commandId`. */
  readonly commandId: string;
  readonly name: string;
  readonly params: unknown;
  /** Ids the local run produced; zipped with the server's `affected` to remap later entries. */
  readonly affected: readonly string[];
  /** Part of the previous entry's undo step (a `coalesce` dispatch): undo / redo move them together. */
  readonly coalesced?: boolean;
  /** Never sent to the server (autosave restore and its follow-ups): the server document stays the truth. */
  readonly localOnly?: boolean;
}

/** Guards against concurrent pushes. */
let syncInFlight = false;
let syncRetryTimer: ReturnType<typeof setTimeout> | null = null;
let syncAttempt = 0;

/** Local id -> server id for ids minted differently while the entries were replayed (kept across retries). */
let flushIdMap = new Map<string, string>();

/**
 * Local id -> name of the refused command that minted it. A refused entry never reaches
 * `extendIdMap`, so its local ids have no server counterpart and could collide with an unrelated
 * server entity: later entries referencing one are dropped, never sent.
 */
let poisonedIds = new Map<string, string>();

/** Local ids of entries the server accepted during this flush (cleared with `flushIdMap`). */
let ackedLocalIds = new Set<string>();

export function newCommandId(): string {
  const cryptoApi = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (typeof cryptoApi?.randomUUID === 'function') return cryptoApi.randomUUID();
  return `cmd-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

function cancelSyncRetry(): void {
  if (syncRetryTimer !== null) clearTimeout(syncRetryTimer);
  syncRetryTimer = null;
}

export function resetSyncBookkeeping(): void {
  cancelSyncRetry();
  syncAttempt = 0;
  flushIdMap = new Map();
  poisonedIds = new Map();
  ackedLocalIds = new Set();
  resetGraceRuns();
}

/**
 * Record the ids a dropped entry created locally (its `affected` ids the server document
 * `serverBase` does not hold) as poisoned, labelled `refusedName`.
 * @invariant ids the server already holds are not poisoned (a refused edit of them leaves them valid):
 *   in `serverBase`, acked earlier in this flush, or introduced by an earlier entry of `localOutbox`.
 */
export function poisonDroppedEntry(
  entry: OutboxCommand,
  serverBase: CadDocument,
  localOutbox: readonly OutboxCommand[],
  refusedName: string = entry.name,
): void {
  const entryIndex = localOutbox.findIndex((queued) => queued.commandId === entry.commandId);
  const earlierIds = new Set<string>();
  for (const earlier of entryIndex < 0 ? [] : localOutbox.slice(0, entryIndex)) {
    for (const id of earlier.affected) earlierIds.add(id);
  }
  for (const id of entry.affected) {
    if (id in serverBase.entities || ackedLocalIds.has(id) || earlierIds.has(id)) continue;
    if (!poisonedIds.has(id)) poisonedIds.set(id, refusedName);
  }
}

/** Name of the refused command whose poisoned id `params` references, if any. */
function refusedDependencyOf(params: unknown): string | undefined {
  if (poisonedIds.size === 0) return undefined;
  let refusedName: string | undefined;
  mapStringLeaves(params, (text) => {
    refusedName ??= poisonedIds.get(text);
    return text;
  });
  return refusedName;
}

/** SSE dropped: stop retrying and release a stale 'syncing' state when no push is in flight. */
export function onSseDisconnected(set: StoreSet, get: StoreGet): void {
  cancelSyncRetry();
  syncAttempt = 0;
  if (!syncInFlight && get().syncState !== 'idle') set({ syncState: 'idle' });
}

/** Offline undo moves the newest outbox command to the redo outbox; redo moves it back. */
export function moveLastOutboxEntry(
  state: CadStoreState,
  direction: 'undo' | 'redo',
): Pick<CadStoreState, 'localOutbox' | 'localRedoOutbox'> {
  const from = direction === 'undo' ? state.localOutbox : state.localRedoOutbox;
  if (from.length === 0) {
    return { localOutbox: state.localOutbox, localRedoOutbox: state.localRedoOutbox };
  }
  // One undo step = its entry plus the coalesced entries that follow it.
  let start = from.length - 1;
  while (start > 0 && from[start]?.coalesced === true) start -= 1;
  const moved = from.slice(start);
  const rest = from.slice(0, start);
  return direction === 'undo'
    ? { localOutbox: rest, localRedoOutbox: [...state.localRedoOutbox, ...moved] }
    : { localOutbox: [...state.localOutbox, ...moved], localRedoOutbox: rest };
}

/** Selection survives a document replacement, minus ids that no longer exist. */
export function withLocalSelection(doc: CadDocument, selection: readonly EntityId[]): CadDocument {
  return { ...doc, selection: selection.filter((id) => id in doc.entities) };
}

export function removeOutboxEntry(
  outbox: readonly OutboxCommand[],
  commandId: string,
): OutboxCommand[] {
  return outbox.filter((entry) => entry.commandId !== commandId);
}

function syncedSummary(sentCount: number, rejected: readonly string[]): string {
  const synced = `Synced ${sentCount} offline command${sentCount === 1 ? '' : 's'} to the server.`;
  return rejected.length === 0
    ? synced
    : `${synced} The server refused ${rejected.length} (dropped): ${rejected.join('; ')}.`;
}

/**
 * Offline -> online reconcile: replay the outbox to the server as ordinary commands, in
 * order (the server rebases them onto whatever happened meanwhile), then adopt the server
 * snapshot. Commands queued during the flush are sent too. Retries with backoff on a transient
 * failure; an entry the server refuses (400/413/422) is dropped, reported in the summary, and the
 * flush continues (the post-flush snapshot reconciles the document).
 * @invariant a connection refusal (401/403/404) stops the flush and keeps the whole outbox and the
 *   local document (no snapshot adopted); syncState 'failed', retried with backoff.
 */
export function flushOutbox(set: StoreSet, get: StoreGet): void {
  if (syncInFlight) return;
  cancelSyncRetry();
  syncInFlight = true;
  set({ syncState: 'syncing' });
  const sent: string[] = [];
  const rejected: string[] = [];
  const sendNext = async (): Promise<void> => {
    for (;;) {
      const next = get().localOutbox[0];
      if (next === undefined) break;
      if (next.localOnly === true) {
        set((state) => ({ localOutbox: removeOutboxEntry(state.localOutbox, next.commandId) }));
        continue;
      }
      const refusedDependency = refusedDependencyOf(next.params);
      if (refusedDependency !== undefined) {
        rejected.push(`'${next.name}' (depends on refused '${refusedDependency}')`);
        poisonDroppedEntry(next, get().liveBase, get().localOutbox, refusedDependency);
        set((state) => ({ localOutbox: removeOutboxEntry(state.localOutbox, next.commandId) }));
        continue;
      }
      try {
        const response = await postCommand(
          next.name,
          remapIds(next.params, flushIdMap),
          next.commandId,
        );
        sent.push(response.summary);
        extendIdMap(flushIdMap, next.affected, response.affected);
        for (const id of next.affected) ackedLocalIds.add(id);
      } catch (err: unknown) {
        if (!isCommandRefusal(err)) throw err;
        rejected.push(`'${next.name}' (${err.message})`);
        poisonDroppedEntry(next, get().liveBase, get().localOutbox);
      }
      set((state) => ({ localOutbox: removeOutboxEntry(state.localOutbox, next.commandId) }));
    }
    const snapshot = await fetchLiveSnapshot();
    if (get().localOutbox.length > 0) return sendNext();
    const state = get();
    flushIdMap = new Map();
    poisonedIds = new Map();
    ackedLocalIds = new Set();
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
      lastSummary: syncedSummary(sent.length, rejected),
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
        lastSummary: isConnectionRefusal(err)
          ? `Could not sync: server refused the connection (auth/origin), offline edits kept (will retry): ${err.message}`
          : `Could not sync offline edits (will retry): ${errorMessage(err)}`,
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
