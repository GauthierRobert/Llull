/**
 * @layer server
 *
 * Single mutation path for the shared live document.
 *
 * `applyCommand` is the ONLY function that mutates the live document. Both the MCP transport
 * (tools/call) and the REST endpoints (/command, /undo, /redo) route through here, so every change
 * — from Claude or from the browser UI — lands in the same undo/redo history and is broadcast to
 * all SSE subscribers.
 *
 * Transport/state glue (L6): no entity construction or geometry here. History mirrors
 * src/ui/store/store.ts dispatch/undo/redo; query commands (data present, document unchanged)
 * return their data without touching history or the broadcast.
 */

import type { CadDocument } from '@core/model/types';
import { withMonotonicStepCounter } from '@core/model/stepCounter';
import { execute, getCommand } from '@core/commands/registry';
import { errorMessage } from '@lib/errorMessage';
import { hashText } from '@lib/hash';
import { getLiveDoc, setLiveDoc } from './liveDocument';

/** Maximum undo/redo depth — mirrors MAX_UNDO_DEPTH in the UI store. */
const MAX_UNDO_DEPTH = 100;

/** Idempotency cache size: commandId -> result, least recently used evicted first. */
const MAX_IDEMPOTENCY_ENTRIES = 1000;
interface CachedResult {
  readonly requestHash: string;
  readonly result: CommandBusResult;
}
const _resultsByCommandId = new Map<string, CachedResult>();

function requestHashOf(name: string, params: unknown): string {
  try {
    return hashText(JSON.stringify([name, params ?? null]));
  } catch {
    return '';
  }
}

type HistoryDirection = 'undo' | 'redo';
const history: Record<HistoryDirection, CadDocument[]> = { undo: [], redo: [] };

const pushCapped = (stack: CadDocument[], doc: CadDocument): CadDocument[] =>
  [...stack, doc].slice(-MAX_UNDO_DEPTH);

/**
 * The value returned by `applyCommand`, `undo`, and `redo`.
 * - `affected` — ids created/changed (empty for queries, undo/redo, and no-ops).
 * - `isError`  — true when `execute` rejected the call (unknown command, invalid params,
 *   kernel unavailable, derivation guard) or the command threw.
 * - `data`     — present only when the command returned data (queries, `build_project` reports).
 */
interface CommandBusResult {
  summary: string;
  affected: string[];
  isError: boolean;
  data?: unknown;
  canUndo: boolean;
  canRedo: boolean;
}

function withHistoryFlags(result: Omit<CommandBusResult, 'canUndo' | 'canRedo'>): CommandBusResult {
  return { ...result, canUndo: canUndo(), canRedo: canRedo() };
}

/**
 * Apply a command to the shared live document.
 * - Unknown command → isError true, document unchanged, no history push.
 * - Query command (data present, document unchanged) → return data; no history, no broadcast.
 * - Mutating command (result.document !== prior) → push prior to the undo stack (capped), clear the
 *   redo stack, `setLiveDoc` (broadcasts). Returns summary/affected (+ data).
 * - No-op (document unchanged, no data) → no history, no broadcast.
 *
 * @param name   - snake_case command name (== MCP tool name).
 * @param params - raw params object forwarded to execute().
 * @param commandId - optional client id; a repeated id returns the cached result without re-applying
 *   (network retries are safe). Only document-changing, non-readOnly results are cached; reuse with
 *   a different name/params is an error result. Bounded LRU of MAX_IDEMPOTENCY_ENTRIES.
 */
export function applyCommand(name: string, params: unknown, commandId?: string): CommandBusResult {
  if (commandId === undefined) return runCommand(name, params).result;
  const requestHash = requestHashOf(name, params);
  const cached = _resultsByCommandId.get(commandId);
  if (cached !== undefined) {
    if (cached.requestHash !== requestHash) {
      return withHistoryFlags({
        summary: `commandId ${commandId} was already used for a different command; use a fresh commandId.`,
        affected: [],
        isError: true,
      });
    }
    _resultsByCommandId.delete(commandId);
    _resultsByCommandId.set(commandId, cached); // refresh LRU position
    return withHistoryFlags(cached.result);
  }
  const { result, changed } = runCommand(name, params);
  if (!changed || getCommand(name)?.annotations?.readOnly === true) return result;
  _resultsByCommandId.set(commandId, { requestHash, result });
  if (_resultsByCommandId.size > MAX_IDEMPOTENCY_ENTRIES) {
    const oldest = _resultsByCommandId.keys().next();
    if (!oldest.done) _resultsByCommandId.delete(oldest.value);
  }
  return result;
}

/** `changed` = the live document was replaced by this call. */
function runCommand(name: string, params: unknown): { result: CommandBusResult; changed: boolean } {
  const prior = getLiveDoc();
  let result: ReturnType<typeof execute>;
  try {
    result = execute(prior, name, params);
  } catch (err) {
    // A throwing command must surface as an error result, never a transport failure.
    return {
      result: withHistoryFlags({
        summary: `Command ${name} failed: ${errorMessage(err)}`,
        affected: [],
        isError: true,
      }),
      changed: false,
    };
  }

  const changed = result.document !== prior;
  if (changed) {
    history.undo = pushCapped(history.undo, prior);
    history.redo = [];
    setLiveDoc(result.document, { name, params });
  }

  const busResult = withHistoryFlags({
    summary: result.summary,
    affected: result.affected,
    isError: result.rejected === true,
    ...(result.data !== undefined ? { data: result.data } : {}),
  });
  return { result: busResult, changed };
}

/**
 * Restore the document on top of `history[from]` and park the displaced one on `history[to]`
 * (`setLiveDoc` broadcasts). An empty `from` stack is a normal no-op result, not an error.
 */
function travelHistory(
  from: HistoryDirection,
  to: HistoryDirection,
  summary: string,
  emptySummary: string,
): CommandBusResult {
  const target = history[from].at(-1);
  if (target === undefined) {
    return withHistoryFlags({ summary: emptySummary, affected: [], isError: false });
  }
  const current = getLiveDoc();
  history[from] = history[from].slice(0, -1);
  history[to] = pushCapped(history[to], current);
  setLiveDoc(withMonotonicStepCounter(target, current));
  return withHistoryFlags({ summary, affected: [], isError: false });
}

/** Undo the last mutating command. */
export function undo(): CommandBusResult {
  return travelHistory('undo', 'redo', 'Undid last change.', 'Nothing to undo.');
}

/** Redo the last undone command. */
export function redo(): CommandBusResult {
  return travelHistory('redo', 'undo', 'Redid last change.', 'Nothing to redo.');
}

export function canUndo(): boolean {
  return history.undo.length > 0;
}

export function canRedo(): boolean {
  return history.redo.length > 0;
}

/** @internal — exposed for tests only. */
export function _resetHistory(): void {
  _resultsByCommandId.clear();
  history.undo = [];
  history.redo = [];
}
