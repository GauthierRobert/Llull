/**
 * @layer server
 *
 * Shared live document — single source of truth for all MCP sessions.
 *
 * All MCP sessions read and write the SAME `CadDocument` held here.
 * Mutations (via `setLiveDoc`) are immediately broadcast to all SSE subscribers
 * so the browser UI sees every MCP tool call in real time.
 *
 * Architecture notes (L6):
 * - This module is TRANSPORT / STATE GLUE only. No command or geometry logic.
 * - `setLiveDoc` stores the document produced by `execute` and fires the SSE fan-out.
 *   It never creates or validates entities.
 * - Sync: one shared doc for every session, broadcast over GET /live.
 */

import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { createAutosaver } from './autosave';
import type { Response } from 'express';
import { createEmptyDocument } from '@core/model/types';
import type { CadDocument } from '@core/model/types';
import { serializeDocument, deserializeDocument } from '@core/commands/persistence';
import { documentHash } from '@mcp/liveSync';
import type { LiveCommandEvent, LiveSnapshotEvent } from '@mcp/liveSync';

/**
 * Autosave path. Override via `LLULL_AUTOSAVE_PATH`; default lives next to the
 * server bundle. Autosave is disabled inside tests (vitest sets `VITEST`, our
 * own harness sets `TEST`) to avoid clobbering a user's saved project.
 */
const AUTOSAVE_PATH =
  process.env['LLULL_AUTOSAVE_PATH'] ?? path.resolve(__dirname, '..', '.autosave.json');

const AUTOSAVE_ENABLED =
  process.env['VITEST'] === undefined &&
  process.env['TEST'] !== 'true' &&
  process.env['LLULL_AUTOSAVE_DISABLED'] !== 'true';

function loadAutosave(): CadDocument {
  if (!AUTOSAVE_ENABLED) return createEmptyDocument();
  try {
    if (!fs.existsSync(AUTOSAVE_PATH)) return createEmptyDocument();
    const json = fs.readFileSync(AUTOSAVE_PATH, 'utf8');
    return deserializeDocument(json);
  } catch (err) {
    console.warn(
      `[liveDocument] autosave load failed (${(err as Error).message}); starting empty.`,
    );
    return createEmptyDocument();
  }
}

const autosaver = createAutosaver({
  filePath: AUTOSAVE_PATH,
  debounceMs: Number.parseInt(process.env['LLULL_AUTOSAVE_DEBOUNCE_MS'] ?? '', 10) || 300,
  serialize: serializeDocument,
});

function writeAutosave(doc: CadDocument): void {
  if (!AUTOSAVE_ENABLED) return;
  autosaver.schedule(doc);
}

/** Write any debounced autosave immediately (shutdown path). */
export function flushAutosave(): void {
  if (AUTOSAVE_ENABLED) autosaver.flush();
}

/** Flush, then write every later mutation synchronously (no debounce). Call at shutdown start. */
export function stopAutosave(): void {
  if (AUTOSAVE_ENABLED) autosaver.stop();
}

/** End every open SSE stream and forget the subscribers (shutdown path). */
export function closeAllSubscribers(): void {
  for (const res of _subscribers) {
    try {
      res.end();
    } catch {
      // already closed
    }
  }
  _subscribers.clear();
}

/** The single live document shared across all MCP sessions and the browser UI. */
let _liveDoc: CadDocument = loadAutosave();

/** Number of changes applied to the live document since process start (the log position). */
let _seq = 0;

/** Random per process: `_seq` restarts at 0 on restart, so clients compare `(epoch, seq)`. */
const _epoch: string = randomUUID();

/** Return the current shared document. */
export function getLiveDoc(): CadDocument {
  return _liveDoc;
}

/** The current document with its log position — `GET /live/snapshot` and the SSE `snapshot` event. */
export function getLiveSnapshot(): LiveSnapshotEvent {
  return { epoch: _epoch, seq: _seq, stateHash: documentHash(_liveDoc), document: _liveDoc };
}

/**
 * Active SSE subscribers — each entry is an Express `Response` whose connection
 * is kept open for the SSE stream.  Entries are added by `subscribeLive` and
 * removed when the client disconnects.
 */
const _subscribers = new Set<Response>();

/**
 * Write a single SSE event to one response, with an event type and JSON data.
 * The named-event format (`event: <type>\ndata: <json>\n\n`) lets the browser
 * hook discriminate between patch and snapshot events via `addEventListener`.
 */
function writeSseEvent(res: Response, eventType: string, payload: unknown): boolean {
  try {
    res.write(`event: ${eventType}\ndata: ${JSON.stringify(payload)}\n\n`);
    return true;
  } catch {
    return false;
  }
}

/** Broadcast one named SSE event to every subscriber, dropping dead connections. */
function broadcast(eventType: 'snapshot' | 'command', payload: unknown): void {
  for (const res of _subscribers) {
    if (!writeSseEvent(res, eventType, payload)) {
      _subscribers.delete(res);
    }
  }
}

/** The mutating command that produced a new live document (broadcast as the log entry). */
interface LiveCommand {
  readonly name: string;
  readonly params: unknown;
}

/**
 * Replace the shared document and broadcast the change to all SSE subscribers.
 *
 * With `command`: emits a `command` event `{ seq, name, params, stateHash }` — clients re-run the
 * same command through `execute` and verify `stateHash`. Without it (undo/redo/reset/bulk
 * replacement): emits a full `snapshot` event `{ seq, stateHash, document }`.
 *
 * @sideeffect replaces module-level `_liveDoc`, advances `_seq`, broadcasts to all subscribers.
 */
export function setLiveDoc(next: CadDocument, command?: LiveCommand): void {
  _liveDoc = next;
  _seq += 1;
  writeAutosave(next);
  if (command === undefined) {
    broadcast('snapshot', getLiveSnapshot());
    return;
  }
  const event: LiveCommandEvent = {
    epoch: _epoch,
    seq: _seq,
    name: command.name,
    params: command.params,
    stateHash: documentHash(next),
  };
  broadcast('command', event);
}

/**
 * Register an SSE subscriber (an Express `Response` already configured for
 * `text/event-stream`).
 *
 * Immediately writes the current document as the opening SSE message so the
 * browser has a snapshot as soon as it connects — no polling needed.
 *
 * Returns an unsubscribe function; call it when the client disconnects.
 */
export function subscribeLive(res: Response): () => void {
  _subscribers.add(res);

  // Send the current snapshot immediately so the browser is in sync from t=0.
  // Named event `snapshot` — the browser hook listens for this distinct event type.
  if (!writeSseEvent(res, 'snapshot', getLiveSnapshot())) {
    // If the write fails immediately the client is already gone; clean up now.
    _subscribers.delete(res);
  }

  return (): void => {
    _subscribers.delete(res);
  };
}

/**
 * Replace the live document without broadcasting (test helper / reset).
 * Production code should always use `setLiveDoc` to ensure the browser is notified.
 *
 * @internal — exposed for tests only.
 */
export function _resetLiveDoc(doc?: CadDocument): void {
  _liveDoc = doc ?? createEmptyDocument();
}

/**
 * Return the current subscriber count (test helper).
 *
 * @internal — exposed for tests only.
 */
export function _subscriberCount(): number {
  return _subscribers.size;
}
