/** @layer ui/store Shape of the single Zustand store and the set/get handles shared by its modules. */

import type { CadDocument, EntityId } from '@core/model/types';
import type { LiveCommandEvent, LiveSnapshotEvent } from '@mcp/liveSync';
import type { OutboxCommand } from './outbox';

/** The structured result of the most recently dispatched read-only/query command. */
interface LastMeasure {
  /** The command name, e.g. 'measure_distance'. */
  command: string;
  /** The structured data returned by the command (typed per command, but stored as unknown here). */
  data: unknown;
}

type SyncState = 'idle' | 'syncing' | 'failed';

export interface DispatchOptions {
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

export type StoreSet = (
  partial: Partial<CadStoreState> | ((state: CadStoreState) => Partial<CadStoreState>),
) => void;
export type StoreGet = () => CadStoreState;
