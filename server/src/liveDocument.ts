/**
 * @layer server
 * Shared live document — the ONE `CadDocument` every MCP session and the browser read and write.
 * `setLiveDoc` stores the document produced by `execute` and broadcasts the change to all SSE
 * subscribers (`GET /live`); transport/state glue only, it never creates or validates entities (L6).
 */

import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { createAutosaver } from './autosave';
import type { Response } from 'express';
import { type CadDocument, createEmptyDocument } from '@core/model/types';
import { serializeDocument, deserializeDocument } from '@core/commands/persistence';
import { errorMessage } from '@lib/errorMessage';
import { type LiveCommandEvent, type LiveSnapshotEvent, documentHash } from '@mcp/liveSync';
import { setAuditDefaultDirectory } from './audit';

/**
 * Autosave path (override via `LLULL_AUTOSAVE_PATH`; default next to the server bundle). Disabled
 * under tests (vitest sets `VITEST`, our harness sets `TEST`) so a user's saved project survives.
 */
const AUTOSAVE_PATH =
  process.env['LLULL_AUTOSAVE_PATH'] ?? path.resolve(__dirname, '..', '.autosave.json');

setAuditDefaultDirectory(path.dirname(AUTOSAVE_PATH));

const AUTOSAVE_ENABLED =
  !process.env['VITEST'] &&
  process.env['TEST'] !== 'true' &&
  process.env['LLULL_AUTOSAVE_DISABLED'] !== 'true';

function loadAutosave(): CadDocument {
  if (!AUTOSAVE_ENABLED) return createEmptyDocument();
  try {
    if (!fs.existsSync(AUTOSAVE_PATH)) return createEmptyDocument();
    const json = fs.readFileSync(AUTOSAVE_PATH, 'utf8');
    return deserializeDocument(json);
  } catch (err) {
    const quarantined = quarantineAutosave();
    console.warn(
      `[liveDocument] autosave load failed (${errorMessage(err)}); ` +
        `${quarantined !== null ? `moved it to ${quarantined}; ` : ''}starting empty.`,
    );
    return createEmptyDocument();
  }
}

/** Rename an unreadable autosave aside so the first autosave cannot overwrite it. */
function quarantineAutosave(): string | null {
  const target = `${AUTOSAVE_PATH}.unreadable-${Date.now()}`;
  try {
    fs.renameSync(AUTOSAVE_PATH, target);
    return target;
  } catch {
    return null;
  }
}

const autosaver = createAutosaver({
  filePath: AUTOSAVE_PATH,
  debounceMs: Number.parseInt(process.env['LLULL_AUTOSAVE_DEBOUNCE_MS'] ?? '', 10) || 300,
  serialize: serializeDocument,
});

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

let _liveDoc: CadDocument = loadAutosave();

/** Number of changes applied to the live document since process start (the log position). */
let _seq = 0;

/** Random per process: `_seq` restarts at 0 on restart, so clients compare `(epoch, seq)`. */
const _epoch: string = randomUUID();

/** Current log position `(epoch, seq)` without hashing the document (audit lines). */
export function getLiveLogPosition(): { epoch: string; seq: number } {
  return { epoch: _epoch, seq: _seq };
}

export function getLiveDoc(): CadDocument {
  return _liveDoc;
}

/** The current document with its log position — `GET /live/snapshot` and the SSE `snapshot` event. */
export function getLiveSnapshot(): LiveSnapshotEvent {
  return { epoch: _epoch, seq: _seq, stateHash: documentHash(_liveDoc), document: _liveDoc };
}

/** Open SSE streams: added by `subscribeLive`, removed on client disconnect. */
const _subscribers = new Set<Response>();

/** Max SSE subscribers; further `GET /live` get 503. */
export const MAX_LIVE_SUBSCRIBERS = 64;

/** A subscriber whose unsent buffer exceeds this is dropped (it resyncs via `/live/snapshot`). */
const MAX_SSE_BACKLOG_BYTES = 8 * 1024 * 1024;

/** One named SSE event (`event: <type>\ndata: <json>\n\n`); false when the connection is dead or too slow. */
function writeSseEvent(res: Response, eventType: string, payload: unknown): boolean {
  try {
    if (res.writableLength > MAX_SSE_BACKLOG_BYTES) {
      res.destroy();
      return false;
    }
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
  /** Named user who ran it (named-user mode only); collaborators see who did what. */
  readonly user?: { readonly id: string; readonly name: string };
}

/**
 * Replace the shared document and broadcast the change.
 * With `command`: a `command` event `{ seq, name, params, stateHash }` (clients re-run it through
 * `execute` and verify `stateHash`). Without it (undo/redo/bulk replacement): a full `snapshot`.
 *
 * @sideeffect replaces `_liveDoc`, advances `_seq`, autosaves, broadcasts to all subscribers.
 */
export function setLiveDoc(next: CadDocument, command?: LiveCommand): void {
  _liveDoc = next;
  _seq += 1;
  if (AUTOSAVE_ENABLED) autosaver.schedule(next);
  if (command === undefined) {
    broadcast('snapshot', getLiveSnapshot());
    return;
  }
  if (_subscribers.size === 0) return; // stateHash is a full serialization; nobody to verify it
  const event: LiveCommandEvent = {
    epoch: _epoch,
    seq: _seq,
    name: command.name,
    params: command.params,
    stateHash: documentHash(next),
    ...(command.user !== undefined ? { userId: command.user.id, userName: command.user.name } : {}),
  };
  broadcast('command', event);
}

/**
 * Register an SSE subscriber (a `Response` already set up for `text/event-stream`) and send it the
 * current snapshot as the opening message. Returns the unsubscribe function.
 */
export function subscribeLive(res: Response): () => void {
  _subscribers.add(res);
  if (!writeSseEvent(res, 'snapshot', getLiveSnapshot())) _subscribers.delete(res); // client already gone

  return (): void => {
    _subscribers.delete(res);
  };
}

/** Replace the live document without broadcasting. @internal — exposed for tests only. */
export function _resetLiveDoc(doc?: CadDocument): void {
  _liveDoc = doc ?? createEmptyDocument();
}

/** Open SSE streams right now. */
export function liveSubscriberCount(): number {
  return _subscribers.size;
}

/** @internal — exposed for tests only. */
export function _subscriberCount(): number {
  return _subscribers.size;
}
