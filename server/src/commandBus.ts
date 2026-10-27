/**
 * The ONLY mutation path of the shared live document (REST /command, /undo, /redo, /exchange, /import): one
 * undo/redo history (rule shared with src/ui/store/localMode.ts via @protocol/history) + SSE broadcast. Queries/no-ops skip history and broadcast.
 */
import type { CadDocument } from '@core/model/types';
import { withMonotonicStepCounter } from '@core/model/stepCounter';
import { getCommand } from '@core/commands/registry';
import { reportServerCrash } from './serverCrash';
import { getLiveDoc, setLiveDoc } from './liveDocument';
import { sha256Hex } from './sha256';
import { emptyHistory, historySummary, recordChange, stepHistory, type History, type HistoryDirection } from '@protocol/history';
import type { LiveCommandSource } from '@protocol/liveSync';
import type { CommandResponseBody } from '@protocol/restProtocol';
import { runHostCommand, runHostCommandResolved, type HostRun } from './plm/hostRun';
import type { JobProgress } from './native/deferredRun';

const MAX_IDEMPOTENCY_ENTRIES = 1000; // commandId -> result LRU
/** commandId -> the command still waiting for its native jobs (a repeat joins it instead of starting a second). */
interface Inflight {
  readonly requestHash: string;
  readonly promise: Promise<CommandResponseBody>;
  /** Aborts the shared resolve once every request that joined has aborted. */
  readonly controller: AbortController;
  /** Requests still interested (a request without a signal never leaves). */
  live: number;
}
const _inflightByCommandId = new Map<string, Inflight>();
interface CachedResult {
  readonly requestHash: string;
  readonly result: CommandResponseBody;
}
const _resultsByCommandId = new Map<string, CachedResult>();

let history: History<CadDocument> = emptyHistory();

function withHistoryFlags(result: Omit<CommandResponseBody, 'canUndo' | 'canRedo'>): CommandResponseBody {
  return { ...result, canUndo: canUndo(), canRedo: canRedo() };
}

/** SHA-256 hex of `value`'s JSON ('' when it cannot be serialised): the idempotency key of a commandId. */
export function hashJson(value: unknown): string {
  try {
    return sha256Hex(JSON.stringify(value ?? null));
  } catch {
    return '';
  }
}

const DIFFERENT_COMMAND = (commandId: string): CommandResponseBody =>
  withHistoryFlags({
    summary: `commandId ${commandId} was already used for a different command; use a fresh commandId.`,
    affected: [],
    isError: true,
    changed: false,
  });

/**
 * Apply a command to the live document; a change pushes the undo stack, clears redo and broadcasts (tagged with `source`).
 * @param commandId repeated id -> cached result, not re-applied (only changing, non-readOnly results are cached;
 *   reuse with different name/params -> error result)
 */
export function applyCommand(name: string, params: unknown, commandId?: string, source?: LiveCommandSource): CommandResponseBody {
  if (commandId === undefined) return runCommand(name, params, source);
  const requestHash = hashJson([name, params]);
  const cached = cachedResult(commandId, requestHash);
  if (cached !== undefined) return cached;
  const result = runCommand(name, params, source, commandId);
  remember(name, commandId, requestHash, result);
  return result;
}

/** The remembered result of a repeated `commandId` (refreshed in the LRU), the refusal of a reuse for another command, or undefined for a new one. */
function cachedResult(commandId: string, requestHash: string): CommandResponseBody | undefined {
  const cached = _resultsByCommandId.get(commandId);
  if (cached === undefined) return undefined;
  if (cached.requestHash !== requestHash) return DIFFERENT_COMMAND(commandId);
  _resultsByCommandId.delete(commandId);
  _resultsByCommandId.set(commandId, cached);
  return withHistoryFlags(cached.result);
}

/** Keep a changing, non-readOnly result for the repeats of its commandId. */
function remember(name: string, commandId: string, requestHash: string, result: CommandResponseBody): void {
  if (!result.changed || getCommand(name)?.annotations?.readOnly === true) return;
  _resultsByCommandId.set(commandId, { requestHash, result: boundedForReplay(result) });
  if (_resultsByCommandId.size > MAX_IDEMPOTENCY_ENTRIES) {
    const oldest = _resultsByCommandId.keys().next();
    if (!oldest.done) _resultsByCommandId.delete(oldest.value);
  }
}

const MAX_CACHED_DATA_CHARS = 64 * 1024;

/** The result remembered for a commandId replay: huge `data` (build reports, scenes) is dropped, and the summary says so. */
function boundedForReplay(result: CommandResponseBody): CommandResponseBody {
  if (result.data === undefined) return result;
  if ((JSON.stringify(result.data)?.length ?? 0) <= MAX_CACHED_DATA_CHARS) return result;
  const { data: _dropped, ...rest } = result;
  void _dropped;
  return { ...rest, summary: `${result.summary} (replay: the result data was not kept, re-query the scene)` };
}

function runCommand(name: string, params: unknown, source?: LiveCommandSource, commandId?: string): CommandResponseBody {
  const prior = getLiveDoc();
  return commit(runHostCommand(prior, name, params, { source: source ?? 'rest' }), prior, name, params, source, commandId);
}

/** Make a finished run the live document (undo entry, broadcast) and answer it; one synchronous step. */
function commit(
  run: HostRun,
  prior: CadDocument,
  name: string,
  params: unknown,
  source: LiveCommandSource | undefined,
  commandId: string | undefined,
): CommandResponseBody {
  const { document, outcome, params: filled, thrown } = run;
  if (thrown !== undefined) reportCommandCrash(thrown, name, params, prior);
  if (outcome.changed && getCommand(name)?.annotations?.session === true) {
    // Session command (resolve_material_libraries): in memory only, no undo entry, no command log; clients get a snapshot.
    setLiveDoc(document);
  } else if (outcome.changed) {
    history = recordChange(history, prior);
    setLiveDoc(document, { name, params: filled, source: source ?? 'rest', ...(commandId !== undefined ? { commandId } : {}) });
  }
  return withHistoryFlags(outcome);
}

export interface AsyncApplyOptions {
  readonly commandId?: string;
  readonly source?: LiveCommandSource;
  /** Reports of the native mesh jobs the command waits for (stage, share done, estimated time left). */
  readonly onProgress?: (event: JobProgress) => void;
  /** Aborting cancels the command: nothing is applied, running native jobs nobody else waits for are killed. */
  readonly signal?: AbortSignal;
}

/**
 * `applyCommand` for any command, including those that need a native mesh job (TECHNICAL_SPEC 13.8): the event loop stays free while the job runs
 * (other requests, live sync, other commands are served), the command takes effect when it finishes, against the document as it is then.
 * A repeated `commandId` while the first call still waits joins it.
 * @failure aborted, timed out or crashed job: a rejection with the job's named code, nothing applied
 */
export async function applyCommandAsync(name: string, params: unknown, options: AsyncApplyOptions = {}): Promise<CommandResponseBody> {
  const { commandId } = options;
  if (commandId === undefined) return runResolved(name, params, options, options.signal);
  const requestHash = hashJson([name, params]);
  const cached = cachedResult(commandId, requestHash);
  if (cached !== undefined) return cached;
  const waiting = _inflightByCommandId.get(commandId);
  if (waiting !== undefined) {
    if (waiting.requestHash !== requestHash) return DIFFERENT_COMMAND(commandId);
    if (waiting.controller.signal.aborted) {
      // every request of the running command has left: it ends in a refusal, nothing to join. Let it settle, then run fresh.
      await waiting.promise;
      return applyCommandAsync(name, params, options);
    }
    follow(waiting, options.signal);
    return waiting.promise;
  }
  const controller = new AbortController();
  const promise = runResolved(name, params, options, controller.signal)
    .then((result) => {
      remember(name, commandId, requestHash, result);
      return result;
    })
    .finally(() => void _inflightByCommandId.delete(commandId));
  const entry: Inflight = { requestHash, promise, controller, live: 0 };
  _inflightByCommandId.set(commandId, entry);
  follow(entry, options.signal);
  return promise;
}

/** A request joins the running command: the shared resolve is aborted only when every request that joined has aborted. */
function follow(entry: Inflight, signal: AbortSignal | undefined): void {
  entry.live += 1;
  if (signal === undefined) return;
  const leave = (): void => {
    entry.live -= 1;
    if (entry.live === 0) entry.controller.abort();
  };
  if (signal.aborted) leave();
  else signal.addEventListener('abort', leave, { once: true });
}

async function runResolved(
  name: string,
  params: unknown,
  options: AsyncApplyOptions,
  signal: AbortSignal | undefined,
): Promise<CommandResponseBody> {
  let response: CommandResponseBody | undefined;
  await runHostCommandResolved(getLiveDoc, name, params, {
    source: options.source ?? 'rest',
    ...(options.onProgress !== undefined ? { onProgress: options.onProgress } : {}),
    ...(signal !== undefined ? { signal } : {}),
    commit: (run) => {
      response = commit(run, run.prior, name, params, options.source, options.commandId);
    },
  });
  return response ?? withHistoryFlags({ summary: `Command ${name} produced no result.`, affected: [], isError: true, changed: false });
}

/** A command threw inside `execute` (a command's own failure summary is not a crash): a rate-limited crash report (SC-D3). */
export function reportCommandCrash(thrown: unknown, name: string, params: unknown, prior: CadDocument): void {
  const report = reportServerCrash('command-threw', thrown, { name, params, document: prior });
  if (report !== null) console.error(`[llull-server] command ${name} threw; crash report: ${report}`);
}

/** Restore the top of the `direction` stack, park the current doc on the other; empty stack -> no-op result. */
function travelHistory(direction: HistoryDirection): CommandResponseBody {
  const current = getLiveDoc();
  const step = stepHistory(history, direction, current);
  if (step === null) return withHistoryFlags({ summary: historySummary(direction, false), affected: [], isError: false, changed: false });
  history = step.history;
  setLiveDoc(withMonotonicStepCounter(step.target, current));
  return withHistoryFlags({ summary: historySummary(direction, true), affected: [], isError: false, changed: true });
}

export function undo(): CommandResponseBody {
  return travelHistory('undo');
}

export function redo(): CommandResponseBody {
  return travelHistory('redo');
}

export function canUndo(): boolean {
  return history.undo.length > 0;
}

export function canRedo(): boolean {
  return history.redo.length > 0;
}

/** @internal tests only */
export function _resetHistory(): void {
  _resultsByCommandId.clear();
  _inflightByCommandId.clear();
  history = emptyHistory();
}
