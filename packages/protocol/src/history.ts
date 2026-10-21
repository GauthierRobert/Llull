/**
 * The undo / redo history rule shared by the backend's live document (`server/src/commandBus.ts`) and the renderer's offline mode
 * (`src/ui/store/localMode.ts`): two bounded snapshot stacks (oldest first), a change pushes the prior snapshot and clears redo, a step
 * parks the current snapshot on the opposite stack. Pure and generic: no document type, DOM or transport here.
 */

const HISTORY_LIMIT = 100;

export type HistoryDirection = 'undo' | 'redo';

export interface History<T> {
  readonly undo: readonly T[];
  readonly redo: readonly T[];
}

export const emptyHistory = <T>(): History<T> => ({ undo: [], redo: [] });

const pushCapped = <T>(stack: readonly T[], snapshot: T): T[] => [...stack, snapshot].slice(-HISTORY_LIMIT);

/** `prior` joins the undo stack (unless `coalesce` folds the change into the previous entry) and redo is cleared. */
export function recordChange<T>(history: History<T>, prior: T, coalesce = false): History<T> {
  const folded = coalesce && history.undo.length > 0;
  return { undo: folded ? history.undo : pushCapped(history.undo, prior), redo: [] };
}

/** The snapshot to restore and the history after parking `current` on the opposite stack; null when `direction` has nothing to restore. */
export function stepHistory<T>(history: History<T>, direction: HistoryDirection, current: T): { target: T; history: History<T> } | null {
  const source = direction === 'undo' ? history.undo : history.redo;
  const target = source.at(-1);
  if (target === undefined) return null;
  const remaining = source.slice(0, -1);
  const parked = pushCapped(direction === 'undo' ? history.redo : history.undo, current);
  return { target, history: direction === 'undo' ? { undo: remaining, redo: parked } : { undo: parked, redo: remaining } };
}

/** The user-facing result text of a step (`changed`) or of an empty stack. */
export const historySummary = (direction: HistoryDirection, changed: boolean): string =>
  changed ? (direction === 'undo' ? 'Undid last change.' : 'Redid last change.') : `Nothing to ${direction}.`;
