/** The ONE shared `CadDocument` (desktop UI + CLI `--app`): store, autosave, SSE broadcast (`GET /live`). */
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { createAutosaver } from './autosave';
import type { Response } from 'express';
import { type CadDocument, createEmptyDocument } from '@core/model/types';
import { serializeDocument, deserializeDocument } from '@core/commands/persistence/serialization';
import { withoutPrivateValues } from '@core/commands/materials/libraryRecords';
import { errorMessage } from '@lib/errorMessage';
import { withoutConfirmations } from '@lib/withoutConfirmations';
import {
  type LiveCommandEvent,
  type LiveCommandSource,
  type LiveProgressReport,
  type LiveSnapshotEvent,
  documentHash,
} from '@protocol/liveSync';
import { isTestRun, positiveInteger } from './env';
import { logLiveCommand, rebaseCommandLog } from './liveCommandLog';

const AUTOSAVE_PATH = process.env['LLULL_AUTOSAVE_PATH'] ?? path.resolve(__dirname, '..', '.autosave.json');

const AUTOSAVE_ENABLED = !isTestRun() /* keep the user's saved project */ && process.env['LLULL_AUTOSAVE_DISABLED'] !== 'true';

function loadAutosave(): CadDocument {
  if (!AUTOSAVE_ENABLED) return createEmptyDocument();
  try {
    return fs.existsSync(AUTOSAVE_PATH) ? deserializeDocument(fs.readFileSync(AUTOSAVE_PATH, 'utf8')) : createEmptyDocument();
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
  debounceMs: positiveInteger(process.env['LLULL_AUTOSAVE_DEBOUNCE_MS'], 300),
  serialize: serializeDocument,
});

export function flushAutosave(): void {
  if (AUTOSAVE_ENABLED) autosaver.flush();
}

/** Flush, then write every later mutation synchronously (shutdown start). */
export function stopAutosave(): void {
  if (AUTOSAVE_ENABLED) autosaver.stop();
}

export function closeAllSubscribers(): void {
  for (const res of _subscribers) {
    try {
      res.end();
    } catch {
      /* already closed */
    }
  }
  _subscribers.clear();
}

let _liveDoc: CadDocument = loadAutosave();
rebaseCommandLog(_liveDoc);

let _seq = 0; // changes since process start
const _epoch: string = randomUUID(); // `_seq` restarts on restart, so clients compare `(epoch, seq)`

export function getLiveDoc(): CadDocument {
  return _liveDoc;
}

/** `GET /live/snapshot` and the SSE `snapshot` event. Values of private material libraries never leave the process (TR-MAT-31). */
export function getLiveSnapshot(): LiveSnapshotEvent {
  return { epoch: _epoch, seq: _seq, stateHash: documentHash(_liveDoc), document: withoutPrivateValues(_liveDoc) };
}

const _subscribers = new Set<Response>();
export const MAX_LIVE_SUBSCRIBERS = 64; // further `GET /live` get 503
/** `LLULL_LIVE_MAX_PER_CLIENT` (default 4): concurrent `GET /live` per client IP; more get 429. */
export const liveMaxPerClient = (): number => positiveInteger(process.env['LLULL_LIVE_MAX_PER_CLIENT'], 8);
/** A subscriber whose unsent buffer exceeds this is dropped (it resyncs via `/live/snapshot`). */
const MAX_SSE_BACKLOG_BYTES = 8 * 1024 * 1024;

/** One named SSE event; false when the connection is dead or too slow. */
function writeSseEvent(res: Response, eventType: string, payload: unknown): boolean {
  try {
    return writeSseFrame(res, sseFrame(eventType, payload));
  } catch {
    return false;
  }
}

function sseFrame(eventType: string, payload: unknown): string {
  return `event: ${eventType}\ndata: ${JSON.stringify(payload)}\n\n`;
}

/** Write an already-serialized frame (one `JSON.stringify` shared by every subscriber). */
function writeSseFrame(res: Response, frame: string): boolean {
  try {
    if (res.writableLength > MAX_SSE_BACKLOG_BYTES) {
      res.destroy();
      return false;
    }
    res.write(frame);
    return true;
  } catch {
    return false;
  }
}

function broadcast(eventType: 'snapshot' | 'command' | 'progress', payload: unknown): void {
  if (_subscribers.size === 0) return;
  let frame: string;
  try {
    frame = sseFrame(eventType, payload);
  } catch {
    _subscribers.clear();
    return;
  }
  for (const res of _subscribers) if (!writeSseFrame(res, frame)) _subscribers.delete(res);
}

interface LiveCommand {
  readonly name: string;
  readonly params: unknown;
  readonly source?: LiveCommandSource;
  readonly commandId?: string;
}

/** Replace the shared document; broadcast a `command` event (clients re-run + verify `stateHash`), or a `snapshot` without one. */
export function setLiveDoc(next: CadDocument, command?: LiveCommand): void {
  _liveDoc = next;
  _seq += 1;
  if (AUTOSAVE_ENABLED) autosaver.schedule(next);
  if (command === undefined) rebaseCommandLog(next);
  else logLiveCommand(next, command.name, command.params);
  if (command === undefined) {
    if (_subscribers.size === 0) return;
    broadcast('snapshot', getLiveSnapshot());
    return;
  }
  if (_subscribers.size === 0) return; // nobody to verify the stateHash
  const event: LiveCommandEvent = {
    epoch: _epoch,
    seq: _seq,
    name: command.name,
    params: withoutConfirmations(command.params),
    stateHash: documentHash(next),
    ...(command.source !== undefined ? { source: command.source } : {}),
    ...(command.commandId !== undefined ? { commandId: command.commandId } : {}),
  };
  broadcast('command', event);
}

/**
 * Tell the live subscribers about a native job of a running command (`progress` event, `@protocol/liveSync`). Touches neither the document, `seq`, the command log
 * nor the state hash: a subscriber that ignores the event type loses nothing.
 */
export function publishLiveProgress(event: LiveProgressReport): void {
  broadcast('progress', { epoch: _epoch, ...event });
}

/** Register an SSE `Response` and send it the opening snapshot; returns the unsubscribe function. */
export function subscribeLive(res: Response): () => void {
  _subscribers.add(res);
  if (!writeSseEvent(res, 'snapshot', getLiveSnapshot())) _subscribers.delete(res);
  return (): void => void _subscribers.delete(res);
}

/** @internal tests only: replace without broadcasting */
export function _resetLiveDoc(doc?: CadDocument): void {
  _liveDoc = doc ?? createEmptyDocument();
  rebaseCommandLog(_liveDoc);
}

export function liveSubscriberCount(): number {
  return _subscribers.size;
}
