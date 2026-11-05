/** The ONE shared `CadDocument` (desktop UI + CLI `--app`): store, autosave, SSE broadcast (`GET /live`). */
import path from 'path';
import { randomUUID } from 'crypto';
import type { AutosaveStatus } from './autosave';
import { createRecoveryStore, newUntitledSlotId } from './recovery';
import { createRecoverySession } from './recoverySession';
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

/** Where the per-document recovery slots live (A-08). The desktop puts them in its user-data folder. */
const RECOVERY_DIR = process.env['LLULL_RECOVERY_DIR'] ?? path.resolve(__dirname, '..', '.recovery');

const AUTOSAVE_ENABLED = !isTestRun() /* keep the user's saved project */ && process.env['LLULL_AUTOSAVE_DISABLED'] !== 'true';

export const recoveryStore = createRecoveryStore(RECOVERY_DIR);

interface StartState {
  readonly doc: CadDocument;
  readonly binding: { id: string; path: string | null };
  /** The state of a crashed backend's slot was loaded. */
  readonly resumed: boolean;
}

/**
 * A fresh backend starts empty and unnamed (the previous session's slots are offered by the UI, never loaded behind the user's back).
 * A backend restarted by the desktop's supervisor (`LLULL_RECOVERY_RESUME=1`) resumes the slot the crashed one was working on (A-10).
 */
function startState(): StartState {
  const fresh: StartState = { doc: createEmptyDocument(), binding: { id: newUntitledSlotId(), path: null }, resumed: false };
  if (!AUTOSAVE_ENABLED || process.env['LLULL_RECOVERY_RESUME'] !== '1') return fresh;
  const active = recoveryStore.readActive();
  const found = active === null ? null : recoveryStore.read(active.id);
  if (active === null || found === null) return fresh;
  try {
    return { doc: deserializeDocument(found.json), binding: { id: active.id, path: found.meta.path }, resumed: true };
  } catch (err) {
    recoveryStore.quarantine(active.id);
    console.warn(`[liveDocument] recovery slot ${active.id} unreadable (${errorMessage(err)}); moved aside, starting empty.`);
    return fresh;
  }
}

const started = startState();

export const recoverySession = createRecoverySession({
  store: recoveryStore,
  debounceMs: positiveInteger(process.env['LLULL_AUTOSAVE_DEBOUNCE_MS'], 300),
  serialize: serializeDocument,
  onStatus: (status) => reportAutosaveStatus(status),
  initial: started.binding,
  announceActive: AUTOSAVE_ENABLED && !started.resumed,
});

let _autosaveStatus: AutosaveStatus = { ok: true };

/** The autosave state (`GET /health`, SSE `status`): ok, or the stable code of the failure that is still standing. */
export function getAutosaveStatus(): AutosaveStatus {
  return _autosaveStatus;
}

function reportAutosaveStatus(status: AutosaveStatus): void {
  _autosaveStatus = status;
  broadcast('status', { epoch: _epoch, autosave: status });
}

export function flushAutosave(): void {
  if (AUTOSAVE_ENABLED) recoverySession.flush();
}

/** Flush, then write every later mutation synchronously (shutdown start). */
export function stopAutosave(): void {
  if (AUTOSAVE_ENABLED) recoverySession.stop();
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

let _liveDoc: CadDocument = started.doc;
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

function broadcast(eventType: 'snapshot' | 'command' | 'progress' | 'status' | 'document', payload: unknown): void {
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
  if (AUTOSAVE_ENABLED) recoverySession.schedule(next);
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

/** Tell the live subscribers which file the document now belongs to (after an open / Save As / restore rebound it). */
export function publishDocumentPath(): void {
  broadcast('document', { epoch: _epoch, path: recoverySession.current().path });
}

/** Register an SSE `Response` and send it the opening snapshot; returns the unsubscribe function. */
export function subscribeLive(res: Response): () => void {
  _subscribers.add(res);
  if (!writeSseEvent(res, 'snapshot', getLiveSnapshot())) _subscribers.delete(res);
  else {
    if (!_autosaveStatus.ok) writeSseEvent(res, 'status', { epoch: _epoch, autosave: _autosaveStatus });
    const documentPath = recoverySession.current().path;
    if (documentPath !== null) writeSseEvent(res, 'document', { epoch: _epoch, path: documentPath });
  }
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
