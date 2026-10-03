/**
 * @layer server
 *
 * Single mutation path for the shared live document.
 *
 * `applyCommand` is the ONLY function that mutates the live document.
 * Both the MCP transport (tools/call) and the REST endpoints (/command, /undo, /redo)
 * route through here so every change — from Claude or from the browser UI — is
 * recorded in the same undo/redo history and broadcast to all SSE subscribers.
 *
 * Architecture notes:
 * - This is transport/state GLUE (L6). No entity construction or geometry here.
 * - History logic mirrors src/ui/store/store.ts dispatch/undo/redo.
 * - Query commands (data present, document unchanged) are detected the same way as the
 *   UI store: return data, skip history push, skip broadcast.
 * - Purity is preserved: `execute` is called once per `applyCommand`; the result
 *   is inspected here and either stored (mutation) or returned as-is (query/no-op).
 */

import type { CadDocument } from '@core/model/types';
import { execute, getCommand } from '@core/commands/registry';
import { getLiveDoc, setLiveDoc } from './liveDocument';

/** Maximum undo/redo depth — mirrors MAX_UNDO_DEPTH in the UI store. */
const MAX_UNDO_DEPTH = 100;

/** Idempotency cache size: commandId -> result, least recently used evicted first. */
const MAX_IDEMPOTENCY_ENTRIES = 1000;
const _resultsByCommandId = new Map<string, CommandBusResult>();

let _undoStack: CadDocument[] = [];
let _redoStack: CadDocument[] = [];

/** Restored history documents keep the newest step counter so undone ids are never re-minted. */
function withMonotonicStepCounter(restored: CadDocument, current: CadDocument): CadDocument {
  const nextStepNumber = Math.max(current.nextStepNumber ?? 1, restored.nextStepNumber ?? 1);
  return restored.nextStepNumber === nextStepNumber ? restored : { ...restored, nextStepNumber };
}

/**
 * The value returned by `applyCommand`, `undo`, and `redo`.
 *
 * Fields:
 * - `summary`  — human + AI readable description of what happened.
 * - `affected` — ids created/changed (empty for queries, undo/redo, and no-ops).
 * - `isError`  — true when the command name is unknown or the command threw.
 * - `data`     — present only for query commands (result.data !== undefined).
 * - `canUndo`  — whether undo is currently available.
 * - `canRedo`  — whether redo is currently available.
 */
interface CommandBusResult {
  summary: string;
  affected: string[];
  isError: boolean;
  data?: unknown;
  canUndo: boolean;
  canRedo: boolean;
}

/**
 * Apply a command to the shared live document.
 *
 * Behaviour:
 * - Unknown command → isError true, document unchanged, no history push.
 * - Query command (data present, document unchanged) → return data; no history, no broadcast.
 * - Mutating command (result.document !== prior) → push prior to undoStack (capped),
 *   clear redoStack, call setLiveDoc (broadcasts). Return summary/affected (+ data, e.g.
 *   build_project's per-step report).
 * - No-op (result.document === prior, no data) → no history, no broadcast.
 *
 * @param name   - snake_case command name (== MCP tool name).
 * @param params - raw params object forwarded to execute().
 * @param commandId - optional client id; a repeated id returns the cached result without re-applying
 *   (network retries are safe). Bounded LRU of MAX_IDEMPOTENCY_ENTRIES.
 */
export function applyCommand(name: string, params: unknown, commandId?: string): CommandBusResult {
  if (commandId === undefined) return runCommand(name, params);
  const cached = _resultsByCommandId.get(commandId);
  if (cached !== undefined) {
    _resultsByCommandId.delete(commandId);
    _resultsByCommandId.set(commandId, cached); // refresh LRU position
    return cached;
  }
  const result = runCommand(name, params);
  _resultsByCommandId.set(commandId, result);
  if (_resultsByCommandId.size > MAX_IDEMPOTENCY_ENTRIES) {
    const oldest = _resultsByCommandId.keys().next();
    if (!oldest.done) _resultsByCommandId.delete(oldest.value);
  }
  return result;
}

function runCommand(name: string, params: unknown): CommandBusResult {
  const isError = getCommand(name) === undefined;
  const prior = getLiveDoc();
  let result: ReturnType<typeof execute>;
  try {
    result = execute(prior, name, params);
  } catch (err) {
    // A throwing command must surface as an error result, never a transport failure.
    return {
      summary: `Command ${name} failed: ${err instanceof Error ? err.message : String(err)}`,
      affected: [],
      isError: true,
      canUndo: canUndo(),
      canRedo: canRedo(),
    };
  }

  if (result.data !== undefined && result.document === prior) {
    // Query command — return data, leave document + history untouched.
    return {
      summary: result.summary,
      affected: result.affected,
      isError,
      data: result.data,
      canUndo: canUndo(),
      canRedo: canRedo(),
    };
  }

  if (result.document !== prior) {
    // Mutating command — record history, broadcast.
    _undoStack = [..._undoStack, prior].slice(-MAX_UNDO_DEPTH);
    _redoStack = [];
    setLiveDoc(result.document, { name, params });
  }
  // No-op: document unchanged, no data — nothing to record or broadcast.

  return {
    summary: result.summary,
    affected: result.affected,
    isError,
    ...(result.data !== undefined ? { data: result.data } : {}),
    canUndo: canUndo(),
    canRedo: canRedo(),
  };
}

/**
 * Undo the last mutating command.
 *
 * Pops the top of the undoStack, pushes the current live doc onto the redoStack,
 * and calls setLiveDoc with the restored document (broadcasts).
 * If the stack is empty, returns a no-op summary without error.
 */
export function undo(): CommandBusResult {
  if (_undoStack.length === 0) {
    return {
      summary: 'Nothing to undo.',
      affected: [],
      isError: false,
      canUndo: false,
      canRedo: canRedo(),
    };
  }
  const current = getLiveDoc();
  const previous = _undoStack[_undoStack.length - 1] as CadDocument;
  _undoStack = _undoStack.slice(0, -1);
  _redoStack = [..._redoStack, current].slice(-MAX_UNDO_DEPTH);
  // fullSnapshot=true: undo replaces the full doc state; a patch would be ambiguous
  // because entities may have been removed in the undone step.
  setLiveDoc(withMonotonicStepCounter(previous, current));
  return {
    summary: 'Undid last change.',
    affected: [],
    isError: false,
    canUndo: canUndo(),
    canRedo: canRedo(),
  };
}

/**
 * Redo the last undone command.
 *
 * Pops the top of the redoStack, pushes the current live doc back onto the
 * undoStack, and calls setLiveDoc with the redone document (broadcasts).
 * If the stack is empty, returns a no-op summary without error.
 */
export function redo(): CommandBusResult {
  if (_redoStack.length === 0) {
    return {
      summary: 'Nothing to redo.',
      affected: [],
      isError: false,
      canUndo: canUndo(),
      canRedo: false,
    };
  }
  const current = getLiveDoc();
  const next = _redoStack[_redoStack.length - 1] as CadDocument;
  _redoStack = _redoStack.slice(0, -1);
  _undoStack = [..._undoStack, current].slice(-MAX_UNDO_DEPTH);
  // fullSnapshot=true: redo reinstates a prior full doc state.
  setLiveDoc(withMonotonicStepCounter(next, current));
  return {
    summary: 'Redid last change.',
    affected: [],
    isError: false,
    canUndo: canUndo(),
    canRedo: canRedo(),
  };
}

/** Whether there is at least one step that can be undone. */
export function canUndo(): boolean {
  return _undoStack.length > 0;
}

/** Whether there is at least one step that can be redone. */
export function canRedo(): boolean {
  return _redoStack.length > 0;
}

/**
 * Reset undo/redo history (test helper).
 *
 * @internal — exposed for tests only.
 */
export function _resetHistory(): void {
  _resultsByCommandId.clear();
  _undoStack = [];
  _redoStack = [];
}
