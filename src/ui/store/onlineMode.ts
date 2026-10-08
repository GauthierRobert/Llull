/**
 * @layer ui/store
 * ONLINE mode: POST /command, /undo, /redo; the document itself arrives over the /live SSE stream.
 * A POST network error while SSE is open never goes local (the command may have executed
 * server-side); HTTP 4xx/5xx never fall back either.
 */

import type { CadDocument, EntityId } from '@core/model/types';
import {
  isCommandRefusal,
  isConnectionRefusal,
  postCommand,
  postRedo,
  postUndo,
  ServerCommandError,
} from './serverCommands';
import type { ServerCommandResponse } from './serverCommands';
import { measureAfter, statusSummaryFor } from './feedback';
import { newCommandId, poisonDroppedEntry, removeOutboxEntry } from './outbox';
import { runLocally, selectionAfter, stepLocalHistory } from './localMode';
import type { CadStoreState, DispatchOptions, StoreGet, StoreSet } from './storeTypes';

const isHttpError = (err: unknown): boolean =>
  err instanceof ServerCommandError && err.kind === 'http';

/**
 * Before the /live stream has connected once, a POST gets this long to answer; past it the command
 * runs locally under the same commandId (replayed idempotently on connect). A refused connection
 * can take seconds to fail, which would otherwise leave the document unchanged that long.
 */
export const CONNECT_GRACE_MS = 400;

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

/** `changed` from the server; older servers omit it, so fall back to a non-error with affected ids. */
function responseChanged(response: ServerCommandResponse): boolean {
  return response.changed ?? (!response.isError && response.affected.length > 0);
}

/**
 * A grace-run command the server then refused (400/413/422) would be re-POSTed forever by the
 * flush: drop its outbox entry, poison the ids it created (later entries using them are dropped
 * by the flush), and tell the user (the post-flush snapshot reconciles the document).
 */
function dropRefusedGraceRun(
  set: StoreSet,
  get: StoreGet,
  commandId: string,
  message: string,
): void {
  const { localOutbox, liveBase } = get();
  const entry = localOutbox.find((queued) => queued.commandId === commandId);
  if (entry !== undefined) poisonDroppedEntry(entry, liveBase);
  set((state) => ({
    localOutbox: removeOutboxEntry(state.localOutbox, commandId),
    lastSummary: `${message} — the server refused the command; it will not be synced.`,
  }));
}

/** A dispatch whose grace timer is armed and whose POST has not settled yet. */
interface PendingGraceRun {
  readonly dispatchSeq: number;
  /** Cancel the grace timer and run the command locally now (no-op if it already ran). */
  readonly runNow: () => void;
}

let lastDispatchSeq = 0;
/** In dispatch order. */
const pendingGraceRuns: PendingGraceRun[] = [];

function forgetGraceRun(dispatchSeq: number): void {
  const index = pendingGraceRuns.findIndex((pending) => pending.dispatchSeq === dispatchSeq);
  if (index >= 0) pendingGraceRuns.splice(index, 1);
}

/**
 * @invariant local run order = dispatch order: before a command falls back locally, every
 * earlier dispatch still inside its grace period runs first (a hung POST must not reorder them).
 */
function runEarlierGraceRuns(dispatchSeq: number): void {
  while (pendingGraceRuns[0] !== undefined && pendingGraceRuns[0].dispatchSeq < dispatchSeq) {
    pendingGraceRuns.shift()?.runNow();
  }
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
  const commandId = newCommandId();
  const dispatchSeq = (lastDispatchSeq += 1);
  let ranLocally = false;
  const runLocalOnce = (): void => {
    if (ranLocally) return;
    ranLocally = true;
    runLocally(set, get, name, params, options, commandId);
  };
  const fallBackLocally = (): void => {
    runEarlierGraceRuns(dispatchSeq);
    runLocalOnce();
  };
  const graceTimer = sseIsDown(get())
    ? setTimeout(() => {
        forgetGraceRun(dispatchSeq);
        if (sseIsDown(get())) fallBackLocally();
      }, CONNECT_GRACE_MS)
    : undefined;
  if (graceTimer !== undefined) {
    const runNow = (): void => {
      clearTimeout(graceTimer);
      runLocalOnce();
    };
    pendingGraceRuns.push({ dispatchSeq, runNow });
  }
  void postCommand(name, params, commandId)
    .then((response) => {
      clearTimeout(graceTimer);
      forgetGraceRun(dispatchSeq);
      if (ranLocally) return;
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
      clearTimeout(graceTimer);
      forgetGraceRun(dispatchSeq);
      if (ranLocally) {
        if (isCommandRefusal(err)) dropRefusedGraceRun(set, get, commandId, err.message);
        else if (isConnectionRefusal(err)) {
          set({
            lastSummary: `${err.message} — server refused the connection (auth/origin), offline edits kept.`,
          });
        }
        return;
      }
      handlePostFailure(set, get, err, `Command '${name}'`, fallBackLocally, (summary) =>
        options?.onResult?.({ summary, changed: false }),
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
