/**
 * @layer ui/store
 * ONLINE mode: POST /command, /undo, /redo; the document itself arrives over the /live SSE stream.
 * A POST network error while SSE is open never goes local (the command may have executed
 * server-side); HTTP 4xx/5xx never fall back either.
 */

import type { CadDocument, EntityId } from '@core/model/types';
import { postCommand, postRedo, postUndo, ServerCommandError } from './serverCommands';
import { newCommandId } from './outbox';
import { runLocally, selectionAfter, stepLocalHistory } from './localMode';
import type { CadStoreState, DispatchOptions, StoreGet, StoreSet } from './storeTypes';

const isHttpError = (err: unknown): boolean =>
  err instanceof ServerCommandError && err.kind === 'http';

/** True when a failed POST means "server never reachable": safe to run locally. */
function sseIsDown(state: CadStoreState): boolean {
  return (
    state.liveStatus === 'disconnected' ||
    (state.liveStatus === 'connecting' && !state.sseEverConnected)
  );
}

function postFailureMessage(err: unknown, what: string): string {
  if (err instanceof ServerCommandError) {
    return err.kind === 'http' ? err.message : `${what} not applied — network error, retry.`;
  }
  return `${what} failed: ${String(err)}`;
}

/** Handle a failed POST: local fallback only when SSE is down; otherwise surface the error. */
function handlePostFailure(
  set: StoreSet,
  get: StoreGet,
  err: unknown,
  what: string,
  runLocal: () => void,
  onFailure?: (summary: string) => void,
): void {
  if (!isHttpError(err) && sseIsDown(get())) {
    set({ liveStatus: 'disconnected' });
    runLocal();
    return;
  }
  const summary = postFailureMessage(err, what);
  set({ lastSummary: summary });
  onFailure?.(summary);
}

/**
 * The affected entities may arrive over SSE after the response, so the selection is taken as-is
 * (snapshot hydration later filters any id that never materialised). If the user changed the
 * selection while the request was in flight, their newer selection wins.
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

/** Fire-and-forget: the document update comes from the /live SSE stream. */
export function postDispatch(
  set: StoreSet,
  get: StoreGet,
  name: string,
  params: unknown,
  options?: DispatchOptions,
): void {
  const selectionAtDispatch = get().document.selection;
  void postCommand(name, params, newCommandId())
    .then((response) => {
      set((state) => ({
        document: selectAffectedIn(state.document, selectionAtDispatch, response.affected, options),
        lastSummary: response.summary,
        canUndo: response.canUndo,
        canRedo: response.canRedo,
        lastMeasure:
          response.data !== undefined ? { command: name, data: response.data } : state.lastMeasure,
      }));
      options?.onResult?.({ summary: response.summary, changed: response.affected.length > 0 });
    })
    .catch((err: unknown) => {
      handlePostFailure(
        set,
        get,
        err,
        `Command '${name}'`,
        () => runLocally(set, get, name, params, options),
        (summary) => options?.onResult?.({ summary, changed: false }),
      );
    });
}

export function postHistoryStep(set: StoreSet, get: StoreGet, direction: 'undo' | 'redo'): void {
  void (direction === 'undo' ? postUndo() : postRedo())
    .then((response) => {
      set({
        lastSummary: response.summary,
        canUndo: response.canUndo,
        canRedo: response.canRedo,
      });
    })
    .catch((err: unknown) => {
      handlePostFailure(set, get, err, direction === 'undo' ? 'Undo' : 'Redo', () =>
        stepLocalHistory(set, get, direction),
      );
    });
}
