/**
 * The single Zustand store; every change goes through `execute`. ONLINE (onlineMode): dispatch POSTs /command, /live
 * events re-run on `liveBase` or hydrate snapshots. LOCAL (localMode) while the backend is unreachable: run locally; the
 * next snapshot replaces the local document. Connectivity is set ONLY by the SSE hook (`setLiveStatus`).
 */

import { create } from 'zustand';
import { type CadDocument, type EntityId, createEmptyDocument } from '@core/model/types';
import { isLocalMode, runLocally, stepLocalHistory } from './localMode';
import { postDispatch, postHistoryStep } from './onlineMode';
import type { CadStoreState, DispatchOptions, LiveStatus } from './storeTypes';
import { type LiveCommandEvent, type LiveSnapshotEvent, applyLiveCommand } from '@protocol/liveSync';
import { reuseUnchanged } from './reuseUnchanged';
import { toggledInList } from '@ui/toggleMember';
import { withFailureTracking } from '@ui/report/failureStore';

/** Selection survives a document replacement, minus ids that no longer exist. */
const withLocalSelection = (doc: CadDocument, selection: readonly EntityId[]): CadDocument => ({
  ...doc,
  selection: selection.filter((id) => id in doc.entities),
});

const REPLACED_LOCAL_EDITS = 'Backend reconnected: edits made while it was offline were replaced by its document.';

export const useStore = create<CadStoreState>()((set, get) => {
  const stepHistory = (direction: 'undo' | 'redo'): void => {
    if (isLocalMode(get())) stepLocalHistory(set, get, direction);
    else postHistoryStep(set, get, direction);
  };
  const setSelection = (selection: EntityId[]): void => set((state) => ({ document: { ...state.document, selection } }));

  return {
    document: createEmptyDocument(),
    lastSummary: null,
    lastMeasure: null,
    canUndo: false,
    canRedo: false,
    renderOrigin: [0, 0, 0],
    liveStatus: 'connecting',
    sseEverConnected: false,
    localUndoStack: [],
    localRedoStack: [],
    liveBase: createEmptyDocument(),
    liveSeq: -1,
    liveEpoch: null,

    dispatch(name: string, params?: unknown, callerOptions?: DispatchOptions): void {
      const options = withFailureTracking(name, params, callerOptions);
      if (isLocalMode(get())) runLocally(set, get, name, params, options);
      else postDispatch(set, get, name, params, options);
    },

    setDocument(doc: CadDocument): void {
      set({ document: doc, lastSummary: null, canUndo: false, canRedo: false, localUndoStack: [], localRedoStack: [] });
    },

    undo: () => stepHistory('undo'),
    redo: () => stepHistory('redo'),

    select: (ids: EntityId[]): void => setSelection([...ids]),

    toggleSelection(id: EntityId): void {
      setSelection(toggledInList(get().document.selection, id));
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
      const { liveEpoch, liveSeq } = get();
      if (snapshot.epoch === liveEpoch && snapshot.seq < liveSeq) return; // stale resync response
      const adopted = reuseUnchanged(get().liveBase, snapshot.document);
      set({
        liveBase: adopted,
        liveSeq: snapshot.seq,
        liveEpoch: snapshot.epoch,
        document: withLocalSelection(reuseUnchanged(get().document, adopted), get().document.selection),
        localUndoStack: [],
        localRedoStack: [],
        ...(get().localUndoStack.length > 0 ? { lastSummary: REPLACED_LOCAL_EDITS } : {}),
      });
    },

    applyLiveCommand(event: LiveCommandEvent): boolean {
      const state = get();
      if (event.epoch === state.liveEpoch && event.seq <= state.liveSeq) return true; // already applied
      if (event.epoch !== state.liveEpoch) return false; // server restarted (or no snapshot yet)
      const applied = applyLiveCommand(state.liveBase, state.liveSeq, event);
      if (!applied.ok) return false;
      set({ liveBase: applied.document, liveSeq: event.seq, document: withLocalSelection(applied.document, state.document.selection) });
      return true;
    },

    setLiveStatus(status: LiveStatus): void {
      set(status === 'connected' ? { liveStatus: status, sseEverConnected: true } : { liveStatus: status });
    },
  };
});
