/**
 * File <-> live document for the desktop menus: changes via POST /command (`load_document`, `clear_document`), Save writes
 * `GET /live/snapshot` in the CLI's --doc format. Unsaved = stateHash differs from the last open/save (selection excluded).
 */
import { createHash } from 'crypto';
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
  /**
   * @returns `warning` DSF_LOCK_UNAVAILABLE when the folder takes no lock file (the document is open without one), else null
   * @failure the file is locked by another writer -> DocumentLockedError (DSF_DOC_LOCKED); the file is not a document -> rejects; nothing changes
   */
  open(filePath: string): Promise<OpenResult>;
  /**
   * Restore recovery slot `slotId` as the live document (`load_document`, then the backend adopts the slot). The session takes the slot's file as
   * its path only when that file still exists, is byte-for-byte the file the slot was started from (its base: sha256 recorded at open / save) and can
   * be locked; otherwise the document is untitled
   * and the next Save is a Save As, so a restore can never overwrite the file that was open before.
   * @failure unknown slot or a document the load refuses -> rejects; the open document, its path, lock and recovery slot are untouched
   */
  restore(slotId: string): Promise<void>;
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

/** The file content the slot starts from, as the backend records it (sha256 + size); null when it is not known. */
interface FileBase {
  readonly baseSha256: string;
  readonly baseSize: number;
}

const baseOfText = (text: string): FileBase => ({
  baseSha256: createHash('sha256').update(text, 'utf8').digest('hex'),
  baseSize: Buffer.byteLength(text, 'utf8'),
});
const baseOfStamp = (stamp: FileStamp | null): FileBase | null =>
  stamp?.sha256 == null ? null : { baseSha256: stamp.sha256, baseSize: stamp.size };

type RecoveryAction = 'hold' | 'release' | 'bind' | 'saved' | 'adopt';
interface RecoveryStep {
  readonly action: 'bind' | 'adopt';
  readonly body: unknown;
}

interface OpenResult {
  readonly warning: 'DSF_LOCK_UNAVAILABLE' | null;
}

interface SessionOptions {
  readonly url: string;
  readonly token: string;
  readonly fetchImpl?: FetchLike;
  /** A recovery problem the user should hear about (default: console.warn). */
  readonly onWarning?: (message: string) => void;
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
  const RESTORED_UNSAVED = 'restored-from-recovery'; // never equals a state hash: a restored document is unsaved

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

  const warn = options.onWarning ?? ((message: string): void => console.warn(`[documents] ${message}`));
  /** One recovery call; the problem as text, or null when the backend took it. */
  const attempt = async (action: RecoveryAction, body: unknown): Promise<string | null> => {
    try {
      const { ok, status } = await requestJson(`${options.url}/recovery/${action}`, {
        body,
        token: options.token,
        fetchImpl: options.fetchImpl,
      });
      return ok ? null : `HTTP ${status}`;
    } catch (error) {
      return errorMessage(error);
    }
  };
  /** The backend's recovery slots (A-08). Best effort: a missed call only makes the backend's slot more conservative (it stays longer). */
  const recovery = async (action: RecoveryAction, body: unknown): Promise<void> => {
    const problem = await attempt(action, body);
    if (problem !== null) console.warn(`[documents] recovery ${action} failed: ${problem}`);
  };
  /** The live document now belongs to `documentPath`'s slot; the previous slot is dropped (the user confirmed the discard or saved). */
  const bindStep = (documentPath: string | null, base: FileBase | null): RecoveryStep => ({
    action: 'bind',
    body: { path: documentPath, dropPrevious: true, ...base },
  });
  const bindRecovery = (documentPath: string | null, base: FileBase | null): Promise<void> =>
    recovery('bind', bindStep(documentPath, base).body);
  /**
   * Replace the live document: the backend keeps the load out of the previous document's recovery slot (`hold`), `finish` rebinds once the
   * load succeeded, and a failed load (`release`) leaves the previous document bound to its own slot, intact. A finishing call that fails
   * twice releases the hold (autosave must not stay paused) and is reported through `onWarning`.
   */
  const replacing = async (load: () => Promise<void>, finish: RecoveryStep): Promise<void> => {
    await recovery('hold', {});
    try {
      await load();
    } catch (error) {
      await recovery('release', {});
      throw error;
    }
    let problem = await attempt(finish.action, finish.body);
    if (problem !== null) problem = await attempt(finish.action, finish.body); // once more
    if (problem === null) return;
    await recovery('release', {});
    warn(
      `recovery ${finish.action} failed (${problem}); the document is open, but its recovery copy may be out of date. Save it to a file.`,
    );
  };
  /** The live document equals a file: its recovery slot is no longer needed. */
  const markRecoverySaved = (stateHash: string, base: FileBase | null): Promise<void> => recovery('saved', { stateHash, ...base });

  /**
   * The file of a restored slot, locked, when it is still the file the slot was started from: its content equals the base recorded in the slot.
   * Null otherwise (no base, a missing or different file, locked elsewhere): the restored document is untitled.
   */
  const claimSlotFile = (slotPath: unknown, baseSha256: unknown): { lock: DocumentLock; stamp: FileStamp } | null => {
    if (typeof slotPath !== 'string' || typeof baseSha256 !== 'string') return null;
    const stamp = stampOf(slotPath);
    if (stamp === null || stamp.sha256 !== baseSha256) return null;
    try {
      return { lock: acquireDocumentLock(slotPath, 'desktop'), stamp };
    } catch {
      return null; // held by another process (or unwritable): never write the restored document over it
    }
  };

  return {
    currentPath: () => currentPath,
    async open(filePath) {
      const absolute = path.resolve(filePath);
      const taken = acquireDocumentLock(absolute, 'desktop');
      let stamp: FileStamp | null;
      let base: FileBase;
      try {
        stamp = stampOf(absolute);
        const json = fs.readFileSync(absolute, 'utf8');
        base = baseOfText(json);
        await replacing(() => command('load_document', { json }), bindStep(absolute, base));
      } catch (error) {
        if (taken.documentPath !== lock?.documentPath) taken.release();
        throw error;
      }
      holdOnly(taken);
      currentPath = absolute;
      loadedStamp = stamp;
      savedHash = (await snapshot()).stateHash;
      await markRecoverySaved(savedHash, base);
      return { warning: taken.warning };
    },
    async restore(slotId) {
      const { ok, status, body } = await requestJson(`${options.url}/recovery/${encodeURIComponent(slotId)}`, {
        token: options.token,
        fetchImpl: options.fetchImpl,
      });
      if (!ok || !isRecord(body) || typeof body['json'] !== 'string' || !isRecord(body['meta']))
        throw new Error(`the recovery copy cannot be read (HTTP ${status})`);
      const json = body['json'];
      const claimed = claimSlotFile(body['meta']['path'], body['meta']['baseSha256']);
      try {
        await replacing(() => command('load_document', { json }), { action: 'adopt', body: { id: slotId } });
      } catch (error) {
        if (claimed !== null && claimed.lock.documentPath !== lock?.documentPath) claimed.lock.release();
        throw error;
      }
      holdOnly(claimed?.lock ?? null);
      currentPath = claimed?.lock.documentPath ?? null;
      loadedStamp = claimed?.stamp ?? null;
      savedHash = RESTORED_UNSAVED;
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
      if (target !== currentPath) await bindRecovery(target, baseOfStamp(loadedStamp));
      currentPath = target;
      savedHash = current.stateHash;
      await markRecoverySaved(savedHash, baseOfStamp(loadedStamp));
      return target;
    },
    async newDocument() {
      await replacing(() => command('clear_document', {}, true), bindStep(null, null));
      holdOnly(null);
      currentPath = null;
      loadedStamp = null;
      savedHash = (await snapshot()).stateHash;
    },
    async currentDocument() {
      return (await snapshot()).document;
    },
    async loadDocument(json) {
      await replacing(() => command('load_document', { json }), bindStep(null, null));
      holdOnly(null);
      currentPath = null;
      loadedStamp = null;
      savedHash = (await snapshot()).stateHash;
      await markRecoverySaved(savedHash, null);
    },
    async hasUnsavedChanges() {
      const current = await snapshot();
      return savedHash === null ? Object.keys(current.document.entities).length > 0 : current.stateHash !== savedHash;
    },
  };
}
