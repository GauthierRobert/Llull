/**
 * LOCAL MODE: while the backend is unreachable (not started yet, restarting) commands run through `execute` in the renderer
 * with a bounded snapshot stack for undo / redo. Nothing is queued: on reconnect the backend's snapshot is adopted (the
 * backend document is the truth; the autosave copy keeps the local work recoverable).
 */

import { execute } from '@core/commands/registry';
import { withMonotonicStepCounter } from '@core/model/stepCounter';
import type { EntityId } from '@core/model/types';
import { measureAfter, statusSummaryFor } from './feedback';
import type { CadStoreState, DispatchOptions, StoreGet, StoreSet } from './storeTypes';

const LOCAL_HISTORY_LIMIT = 100;
const LOCAL_SUFFIX = ' (ran locally — backend offline)';

/** Commands must run locally (never POST) in this state. */
export function isLocalMode(state: CadStoreState): boolean {
  return state.liveStatus === 'disconnected';
}

/** Larger results (a building template, a big array) are not auto-selected: noise, not a selection. */
export const MAX_AUTO_SELECT = 100;

/** Affected ids when requested, non-empty and ≤ MAX_AUTO_SELECT; else unchanged. */
export function selectionAfter(current: EntityId[], affected: readonly EntityId[], options: DispatchOptions | undefined): EntityId[] {
  return options?.selectAffected === true && affected.length > 0 && affected.length <= MAX_AUTO_SELECT ? [...affected] : current;
}

/** Pushes history only when the document changed. */
export function runLocally(set: StoreSet, get: StoreGet, name: string, params: unknown, options?: DispatchOptions): void {
  const state = get();
  const result = execute(state.document, name, params);
  const summary = `${result.summary}${LOCAL_SUFFIX}`;
  const lastMeasure = measureAfter(name, result.data, state.lastMeasure);
  const shown = statusSummaryFor(name, summary, options) ?? state.lastSummary;
  if (result.document === state.document) {
    set({ lastSummary: shown, lastMeasure });
    options?.onResult?.({ summary, changed: false });
    return;
  }
  const coalesce = options?.coalesce === true && state.localUndoStack.length > 0;
  set({
    document: { ...result.document, selection: selectionAfter(result.document.selection, result.affected, options) },
    lastSummary: shown,
    lastMeasure,
    localUndoStack: coalesce ? state.localUndoStack : [...state.localUndoStack, state.document].slice(-LOCAL_HISTORY_LIMIT),
    localRedoStack: [],
    canUndo: true,
    canRedo: false,
  });
  options?.onResult?.({ summary, changed: true });
}

export function stepLocalHistory(set: StoreSet, get: StoreGet, direction: 'undo' | 'redo'): void {
  const state = get();
  const source = direction === 'undo' ? state.localUndoStack : state.localRedoStack;
  const target = source[source.length - 1];
  if (target === undefined) {
    set({ lastSummary: `Nothing to ${direction}.${LOCAL_SUFFIX}` });
    return;
  }
  const remaining = source.slice(0, -1);
  const other = [...(direction === 'undo' ? state.localRedoStack : state.localUndoStack), state.document];
  const undoStack = direction === 'undo' ? remaining : other.slice(-LOCAL_HISTORY_LIMIT);
  const redoStack = direction === 'undo' ? other : remaining;
  set({
    document: { ...withMonotonicStepCounter(target, state.document), selection: target.selection.filter((id) => id in target.entities) },
    localUndoStack: undoStack,
    localRedoStack: redoStack,
    canUndo: undoStack.length > 0,
    canRedo: redoStack.length > 0,
    lastSummary: `${direction === 'undo' ? 'Undid' : 'Redid'} last step.${LOCAL_SUFFIX}`,
  });
}
