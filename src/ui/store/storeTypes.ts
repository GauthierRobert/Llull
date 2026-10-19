import type { CadDocument, EntityId } from '@core/model/types';
import type { LiveCommandEvent, LiveSnapshotEvent } from '@protocol/liveSync';

/** Result `data` of the most recent read-only/query command. */
export interface LastMeasure {
  command: string;
  data: unknown;
}

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
  /** Distinguishes first connect from reconnect. */
  sseEverConnected: boolean;
  /** Oldest first, bounded by LOCAL_HISTORY_LIMIT. */
  localUndoStack: CadDocument[];
  localRedoStack: CadDocument[];
  /** Client copy of the server document at log position `liveSeq` (-1 before the first snapshot). */
  liveBase: CadDocument;
  liveSeq: number;
  /** Server process epoch of `liveSeq`; seqs compare only within one epoch. */
  liveEpoch: string | null;
  /** POST /command while the backend is reachable, local `execute` while it is not. */
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
