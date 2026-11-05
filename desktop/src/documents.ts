/**
 * File <-> live document for the desktop menus: changes via POST /command (`load_document`, `clear_document`), Save writes
 * `GET /live/snapshot` in the CLI's --doc format. Unsaved = stateHash differs from the last open/save (selection excluded).
 */
import fs from 'fs';
import path from 'path';
import type { CadDocument } from '@core/model/types';
import { errorMessage } from '@lib/errorMessage';
import { isRecord } from '@lib/isRecord';
import { outcomeIsFailure } from '@protocol/commandOutcome';
import { parseCommandResponse } from '@protocol/restProtocol';
import { requestJson, type FetchLike } from '@server/restClient';
import { type FileStamp, stampOf, writeDocumentFile } from '@server/documentFile';
import { acquireDocumentLock, type DocumentLock } from '@server/documentLock';

interface Snapshot {
  readonly stateHash: string;
  readonly document: CadDocument;
}

export interface DocumentSession {
  readonly currentPath: () => string | null; // absolute; null = unsaved
  /** @failure the file is locked by another writer -> DocumentLockedError (DSF_DOC_LOCKED); nothing changes */
  open(filePath: string): Promise<void>;
  /**
   * Save As `filePath`, or to the current path. @failure no path -> rejects; another process holds the file's lock -> DocumentLockedError
   * (DSF_DOC_LOCKED); the file changed on disk since it was opened or last saved -> SaveConflictError (DSF_SAVE_CONFLICT) unless `overwrite`
   */
  save(filePath?: string, options?: { readonly overwrite?: boolean }): Promise<string>;
  newDocument(): Promise<void>;
  /** The live document of the app (what Save would write). */
  currentDocument(): Promise<CadDocument>;
  /** Replace the live document with a serialized one (Vault check-out / check-in); the result counts as saved, with no file path. */
  loadDocument(json: string): Promise<void>;
  hasUnsavedChanges(): Promise<boolean>;
}

interface SessionOptions {
  readonly url: string;
  readonly token: string;
  readonly fetchImpl?: FetchLike;
}

export function createDocumentSession(options: SessionOptions): DocumentSession {
  let currentPath: string | null = null;
  let lock: DocumentLock | null = null; // the lock file of the open document (A-09): held while it is open
  let loadedStamp: FileStamp | null = null; // the file as opened / last saved (DSF_SAVE_CONFLICT)
  const holdOnly = (next: DocumentLock | null): void => {
    const previous = lock;
    lock = next;
    if (previous !== null && previous !== next && previous.documentPath !== next?.documentPath) previous.release();
  };
  let savedHash: string | null = null;

  const snapshot = async (): Promise<Snapshot> => {
    const { ok, status, body } = await requestJson(`${options.url}/live/snapshot`, { token: options.token, fetchImpl: options.fetchImpl });
    if (!ok || !isRecord(body) || typeof body['stateHash'] !== 'string')
      throw new Error(`cannot read the document from the backend (HTTP ${status})`);
    return { stateHash: body['stateHash'], document: body['document'] as CadDocument };
  };

  /** POST /command; `mayNoop`: a command that changes nothing is fine (clearing an empty doc). */
  const command = async (name: string, params: unknown, mayNoop = false): Promise<void> => {
    const { status, body } = await requestJson(`${options.url}/command`, {
      body: { name, params },
      token: options.token,
      fetchImpl: options.fetchImpl,
    });
    const outcome = parseCommandResponse(body, status);
    if (outcomeIsFailure(name, outcome, mayNoop))
      throw new Error(outcome.summary !== '' ? outcome.summary : `${name} failed (HTTP ${status})`);
  };

  /**
   * The backend's recovery slots (A-08). Best effort: a failure here must never stop a document operation, and the backend's own slot
   * only gets more conservative when a call is missed (a slot stays longer).
   */
  const recovery = async (action: 'bind' | 'saved', body: unknown): Promise<void> => {
    try {
      await requestJson(`${options.url}/recovery/${action}`, { body, token: options.token, fetchImpl: options.fetchImpl });
    } catch (error) {
      console.warn(`[documents] recovery ${action} failed: ${errorMessage(error)}`);
    }
  };
  /** Called BEFORE another document is loaded: its autosaves go to that document's own slot, the previous slot is the user's call (confirmed discard). */
  const bindRecovery = (documentPath: string | null): Promise<void> => recovery('bind', { path: documentPath, dropPrevious: true });
  /** The live document equals a file: its recovery slot is no longer needed. */
  const markRecoverySaved = (stateHash: string): Promise<void> => recovery('saved', { stateHash });

  return {
    currentPath: () => currentPath,
    async open(filePath) {
      const absolute = path.resolve(filePath);
      const taken = acquireDocumentLock(absolute, 'desktop');
      try {
        loadedStamp = stampOf(absolute);
        const json = fs.readFileSync(absolute, 'utf8');
        await bindRecovery(absolute);
        await command('load_document', { json });
      } catch (error) {
        if (taken.documentPath !== lock?.documentPath) taken.release();
        throw error;
      }
      holdOnly(taken);
      currentPath = absolute;
      savedHash = (await snapshot()).stateHash;
      await markRecoverySaved(savedHash);
    },
    async save(filePath, saveOptions) {
      const target = filePath !== undefined ? path.resolve(filePath) : currentPath;
      if (target === null) throw new Error('no file chosen for this document (use Save As)');
      const current = await snapshot();
      const taken = target === currentPath && lock !== null ? lock : acquireDocumentLock(target, 'desktop');
      try {
        // The conflict check applies to the file this session opened or saved; Save As onto another file was confirmed by the OS dialog.
        const guard = target === currentPath && saveOptions?.overwrite !== true ? { stamp: loadedStamp } : undefined;
        loadedStamp = writeDocumentFile(target, current.document, guard);
      } catch (error) {
        if (taken !== lock) taken.release();
        throw error;
      }
      holdOnly(taken);
      if (target !== currentPath) await bindRecovery(target);
      currentPath = target;
      savedHash = current.stateHash;
      await markRecoverySaved(savedHash);
      return target;
    },
    async newDocument() {
      await bindRecovery(null);
      await command('clear_document', {}, true);
      holdOnly(null);
      currentPath = null;
      loadedStamp = null;
      savedHash = (await snapshot()).stateHash;
    },
    async currentDocument() {
      return (await snapshot()).document;
    },
    async loadDocument(json) {
      await bindRecovery(null);
      await command('load_document', { json });
      holdOnly(null);
      currentPath = null;
      loadedStamp = null;
      savedHash = (await snapshot()).stateHash;
      await markRecoverySaved(savedHash);
    },
    async hasUnsavedChanges() {
      const current = await snapshot();
      return savedHash === null ? Object.keys(current.document.entities).length > 0 : current.stateHash !== savedHash;
    },
  };
}
