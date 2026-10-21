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
import { runHostCommand } from './plm/hostRun';

const MAX_IDEMPOTENCY_ENTRIES = 1000; // commandId -> result LRU
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

/**
 * Apply a command to the live document; a change pushes the undo stack, clears redo and broadcasts (tagged with `source`).
 * @param commandId repeated id -> cached result, not re-applied (only changing, non-readOnly results are cached;
 *   reuse with different name/params -> error result)
 */
export function applyCommand(name: string, params: unknown, commandId?: string, source?: LiveCommandSource): CommandResponseBody {
  if (commandId === undefined) return runCommand(name, params, source);
  const requestHash = hashJson([name, params]);
  const cached = _resultsByCommandId.get(commandId);
  if (cached !== undefined) {
    if (cached.requestHash !== requestHash) {
      return withHistoryFlags({
        summary: `commandId ${commandId} was already used for a different command; use a fresh commandId.`,
        affected: [],
        isError: true,
        changed: false,
      });
    }
    _resultsByCommandId.delete(commandId);
    _resultsByCommandId.set(commandId, cached); // refresh LRU position
    return withHistoryFlags(cached.result);
  }
  const result = runCommand(name, params, source, commandId);
  if (!result.changed || getCommand(name)?.annotations?.readOnly === true) return result;
  _resultsByCommandId.set(commandId, { requestHash, result: boundedForReplay(result) });
  if (_resultsByCommandId.size > MAX_IDEMPOTENCY_ENTRIES) {
    const oldest = _resultsByCommandId.keys().next();
    if (!oldest.done) _resultsByCommandId.delete(oldest.value);
  }
  return result;
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
  const { document, outcome, params: filled, thrown } = runHostCommand(prior, name, params, { source: source ?? 'rest' });
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

/** A command threw inside `execute` (a command's own failure summary is not a crash): a rate-limited crash report (SC-D3). */
function reportCommandCrash(thrown: unknown, name: string, params: unknown, prior: CadDocument): void {
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
  history = emptyHistory();
}
