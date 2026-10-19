import type { CadDocument, EntityId } from '@core/model/types';
import type { LiveCommandEvent, LiveSnapshotEvent } from '@protocol/liveSync';

/** Result `data` of the most recent read-only/query command. */
export interface LastMeasure {
  command: string;
  data: unknown;
}

type SyncState = 'idle' | 'syncing' | 'failed';

export type LiveStatus = 'connecting' | 'connected' | 'disconnected';

interface DispatchResult {
  summary: string;
  /** `affected` non-empty / new document. */
  changed: boolean;
}

export interface DispatchOptions {
  selectAffected?: boolean;
  /** Called once with THIS dispatch's outcome (also on a failed POST), never with another's. */
  onResult?: (result: DispatchResult) => void;
  /** Leave the status-bar summary untouched (automatic UI commands such as framing). */
  quiet?: boolean;
  /** Local mode: fold into the previous undo step (automatic follow-ups such as framing) so one Undo reverts both. */
  coalesce?: boolean;
  /** Local mode: never replayed to the server (autosave restore: a stale copy must not replace the live document); inherited by a coalesced follow-up. */
  localOnly?: boolean;
}

export interface CadStoreState {
  /** Single source of truth, hydrated by the /live SSE stream. */
  document: CadDocument;
  /** Floating-origin render offset — render-only, not in the document. */
  renderOrigin: [number, number, number];
  lastSummary: string | null;
  lastMeasure: LastMeasure | null;
  canUndo: boolean;
  canRedo: boolean;
  liveStatus: LiveStatus;
  /** Local (offline) edits the server has not received. */
  hasUnsyncedLocalEdits: boolean;
  /** Bumped per local command / local undo-redo step, never by selection. */
  localEditCounter: number;
  /** 'syncing' = offline→online push pending/in flight, 'failed' = awaiting retry. */
  syncState: SyncState;
  /** Distinguishes first connect from reconnect. */
  sseEverConnected: boolean;
  /** Oldest first, bounded by LOCAL_HISTORY_LIMIT. */
  localUndoStack: CadDocument[];
  localRedoStack: CadDocument[];
  /** Local mutating commands, in order, that turned the last server state into the current local document. */
  localOutbox: OutboxCommand[];
  /** Undone offline entries (most recent last); re-queued by local redo. */
  localRedoOutbox: OutboxCommand[];
  /** Client copy of the server document at log position `liveSeq` (-1 before the first snapshot). */
  liveBase: CadDocument;
  liveSeq: number;
  /** Server process epoch of `liveSeq`; seqs compare only within one epoch. */
  liveEpoch: string | null;
  /** POST /command online, local `execute` offline. */
  dispatch(name: string, params?: unknown, options?: DispatchOptions): void;
  /** Replace wholesale (load / reset). */
  setDocument(doc: CadDocument): void;
  undo(): void;
  redo(): void;

  select(ids: EntityId[]): void;
  toggleSelection(id: EntityId): void;
  clearSelection(): void;
  setRenderOrigin(origin: [number, number, number]): void;

  clearLastMeasure(): void;

  /** UI-only status-bar message. */
  setStatusMessage(message: string): void;
  hydrateLiveDocument(snapshot: LiveSnapshotEvent): void;

  /** Re-run a broadcast command through `execute` on `liveBase` and verify the server's state hash. */
  applyLiveCommand(event: LiveCommandEvent): boolean;

  setLiveStatus(status: LiveStatus): void;
}

export type StoreSet = (partial: Partial<CadStoreState> | ((state: CadStoreState) => Partial<CadStoreState>)) => void;
export type StoreGet = () => CadStoreState;

export interface OutboxCommand {
  /** Idempotency key: the flush acks by it and sends it as `commandId`. */
  readonly commandId: string;
  readonly name: string;
  readonly params: unknown;
  /** Ids the local run produced; zipped with the server's `affected` to remap later entries. */
  readonly affected: readonly string[];
  /** Part of the previous entry's undo step (`coalesce`): undo / redo move them together. */
  readonly coalesced?: boolean;
  /** Never sent (autosave restore + follow-ups): the server document stays the truth. */
  readonly localOnly?: boolean;
}
