// ONLINE mode: POST /command, /undo, /redo; the document arrives over /live SSE. A POST network error while SSE is
// open never goes local (it may have executed server-side); HTTP 4xx/5xx never fall back either. Before /live first
// connects (or after it dropped) a refused connection runs the command locally instead.

import type { CadDocument, EntityId } from '@core/model/types';
import { postCommand, postRedo, postUndo, ServerCommandError } from './serverCommands';
import type { ServerCommandResponse } from './serverCommands';
import { measureAfter, statusSummaryFor } from './feedback';
import { newCommandId } from './liveOrigin';
import { runLocally, selectionAfter, stepLocalHistory } from './localMode';
import type { CadStoreState, DispatchOptions, StoreGet, StoreSet } from './storeTypes';

const isHttpError = (err: unknown): boolean => err instanceof ServerCommandError && err.kind === 'http';

/** "Server never reachable": safe to run locally. */
function sseIsDown(state: CadStoreState): boolean {
  return state.liveStatus === 'disconnected' || (state.liveStatus === 'connecting' && !state.sseEverConnected);
}

function postFailureMessage(err: unknown, what: string): string {
  if (err instanceof ServerCommandError) return err.kind === 'http' ? err.message : `${what} not applied — network error, retry.`;
  return `${what} failed: ${String(err)}`;
}

/** Local fallback only when SSE is down; else surface the error. */
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

/** Affected ids are taken as-is (may arrive over SSE later; hydration filters ghosts); a newer user selection wins. */
function selectAffectedIn(
  doc: CadDocument,
  selectionAtDispatch: readonly EntityId[],
  affected: readonly EntityId[],
  options: DispatchOptions | undefined,
): CadDocument {
  const unchanged =
    doc.selection.length === selectionAtDispatch.length && doc.selection.every((id, index) => id === selectionAtDispatch[index]);
  if (!unchanged) return doc;
  const selection = selectionAfter(doc.selection, affected, options);
  return selection === doc.selection ? doc : { ...doc, selection };
}

/** Older servers omit `changed`: fall back to a non-error with affected ids. */
function responseChanged(response: ServerCommandResponse): boolean {
  return response.changed ?? (!response.isError && response.affected.length > 0);
}

/** Fire-and-forget: the document update comes over /live. */
export function postDispatch(set: StoreSet, get: StoreGet, name: string, params: unknown, options?: DispatchOptions): void {
  const selectionAtDispatch = get().document.selection;
  const commandId = newCommandId();
  void postCommand(name, params, commandId)
    .then((response) => {
      set((state) => ({
        document: selectAffectedIn(state.document, selectionAtDispatch, response.affected, options),
        lastSummary: statusSummaryFor(name, response.summary, options) ?? state.lastSummary,
        canUndo: response.canUndo,
        canRedo: response.canRedo,
        lastMeasure: measureAfter(name, response.data, state.lastMeasure),
      }));
      options?.onResult?.({ summary: response.summary, changed: responseChanged(response) });
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
      set({ lastSummary: response.summary, canUndo: response.canUndo, canRedo: response.canRedo });
    })
    .catch((err: unknown) => {
      handlePostFailure(set, get, err, direction === 'undo' ? 'Undo' : 'Redo', () => stepLocalHistory(set, get, direction));
    });
}
