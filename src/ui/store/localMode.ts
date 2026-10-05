/**
 * @layer ui/store
 * LOCAL MODE (offline, L6): commands run through `execute` with a bounded snapshot stack and are
 * queued in `localOutbox` for replay (`./outbox`).
 */

import { execute } from '@core/commands/registry';
import { withMonotonicStepCounter } from '@core/model/stepCounter';
import type { EntityId } from '@core/model/types';
import { moveLastOutboxEntry, newCommandId } from './outbox';
import type { CadStoreState, DispatchOptions, StoreGet, StoreSet } from './storeTypes';

const LOCAL_HISTORY_LIMIT = 100;
const LOCAL_SUFFIX = ' (ran locally — offline)';

/** Commands must run locally (never POST) in this state. */
export function isLocalMode(state: CadStoreState): boolean {
  return (
    state.liveStatus === 'disconnected' || state.syncState !== 'idle' || state.hasUnsyncedLocalEdits
  );
}

/** Local undo/redo would move the in-flight outbox entry; refuse until the flush finishes. */
export function refuseDuringSync(set: StoreSet, get: StoreGet): boolean {
  if (get().syncState === 'idle') return false;
  set({ lastSummary: 'Sync in progress — undo/redo after it finishes.' });
  return true;
}

/** Selection after a command: its affected ids when requested and non-empty, else unchanged. */
export function selectionAfter(
  current: EntityId[],
  affected: readonly EntityId[],
  options: DispatchOptions | undefined,
): EntityId[] {
  return options?.selectAffected === true && affected.length > 0 ? [...affected] : current;
}

/** Run a command locally via `execute`. Pushes history only if the doc changed. */
export function runLocally(
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
    options?.onResult?.({ summary, changed: false });
    return;
  }
  set({
    document: {
      ...result.document,
      selection: selectionAfter(result.document.selection, result.affected, options),
    },
    lastSummary: summary,
    lastMeasure,
    localUndoStack: [...state.localUndoStack, state.document].slice(-LOCAL_HISTORY_LIMIT),
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
  options?.onResult?.({ summary, changed: true });
}

/** Step the local snapshot history (offline undo/redo). */
export function stepLocalHistory(set: StoreSet, get: StoreGet, direction: 'undo' | 'redo'): void {
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
    ...moveLastOutboxEntry(state, direction),
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
