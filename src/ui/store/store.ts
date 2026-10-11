/**
 * @layer ui/store
 * Single Zustand store (the app's one source of truth). Every change goes through
 * `execute(doc, name, params)`.
 * - ONLINE (`./onlineMode`): `dispatch` POSTs /command; /live events are re-run on `liveBase`
 *   (`applyLiveCommand`) or adopted as snapshots (`hydrateLiveDocument`).
 * - LOCAL MODE (`./localMode`): when liveStatus is 'disconnected', syncState is not 'idle', or
 *   hasUnsyncedLocalEdits, commands run locally and are queued in `localOutbox` for replay
 *   (`./outbox`).
 * Connectivity is decided ONLY by the SSE hook (`setLiveStatus`).
 */

import { create } from 'zustand';
import { type CadDocument, type EntityId, createEmptyDocument } from '@core/model/types';
import { flushOutbox, onSseDisconnected, resetSyncBookkeeping, withLocalSelection } from './outbox';
import { isLocalMode, refuseDuringSync, runLocally, stepLocalHistory } from './localMode';
import { postDispatch, postHistoryStep } from './onlineMode';
import type { CadStoreState, DispatchOptions, LiveStatus } from './storeTypes';
import { type LiveCommandEvent, type LiveSnapshotEvent, applyLiveCommand } from '@mcp/liveSync';

export const useStore = create<CadStoreState>()((set, get) => {
  const stepHistory = (direction: 'undo' | 'redo'): void => {
    if (refuseDuringSync(set, get)) return;
    if (isLocalMode(get())) stepLocalHistory(set, get, direction);
    else postHistoryStep(set, get, direction);
  };
  const setSelection = (selection: EntityId[]): void =>
    set((state) => ({ document: { ...state.document, selection } }));

  return {
    document: createEmptyDocument(),
    lastSummary: null,
    lastMeasure: null,
    canUndo: false,
    canRedo: false,
    renderOrigin: [0, 0, 0],
    liveStatus: 'connecting',
    hasUnsyncedLocalEdits: false,
    localEditCounter: 0,
    syncState: 'idle',
    sseEverConnected: false,
    localUndoStack: [],
    localRedoStack: [],
    localOutbox: [],
    localRedoOutbox: [],
    liveBase: createEmptyDocument(),
    liveSeq: -1,
    liveEpoch: null,

    dispatch(name: string, params?: unknown, options?: DispatchOptions): void {
      if (isLocalMode(get())) runLocally(set, get, name, params, options);
      else postDispatch(set, get, name, params, options);
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

    undo: () => stepHistory('undo'),
    redo: () => stepHistory('redo'),

    select: (ids: EntityId[]): void => setSelection([...ids]),

    toggleSelection(id: EntityId): void {
      const current = get().document.selection;
      setSelection(
        current.includes(id) ? current.filter((existingId) => existingId !== id) : [...current, id],
      );
    },

    clearSelection: (): void => setSelection([]),

    setRenderOrigin(origin: [number, number, number]): void {
      set({ renderOrigin: origin });
    },

    clearLastMeasure(): void {
      set({ lastMeasure: null });
    },

    setStatusMessage(message: string): void {
      set({ lastSummary: message });
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

    setLiveStatus(status: LiveStatus): void {
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
  };
});
