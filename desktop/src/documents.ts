/**
 * File <-> live document for the desktop menus: changes via POST /command (`load_document`, `clear_document`), Save writes
 * `GET /live/snapshot` in the CLI's --doc format. Unsaved = stateHash differs from the last open/save (selection excluded).
 */
import fs from 'fs';
import path from 'path';
import type { CadDocument } from '@core/model/types';
import { isRecord } from '@lib/isRecord';
import { outcomeIsFailure } from '@protocol/commandOutcome';
import { parseCommandResponse } from '@protocol/restProtocol';
import { requestJson, type FetchLike } from '@server/restClient';
import { writeDocumentFile } from '@server/documentFile';

interface Snapshot {
  readonly stateHash: string;
  readonly document: CadDocument;
}

export interface DocumentSession {
  readonly currentPath: () => string | null; // absolute; null = unsaved
  open(filePath: string): Promise<void>;
  /** Save As `filePath`, or to the current path. @failure no path -> rejects */
  save(filePath?: string): Promise<string>;
  newDocument(): Promise<void>;
  hasUnsavedChanges(): Promise<boolean>;
}

interface SessionOptions {
  readonly url: string;
  readonly token: string;
  readonly fetchImpl?: FetchLike;
}

export function createDocumentSession(options: SessionOptions): DocumentSession {
  let currentPath: string | null = null;
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

  return {
    currentPath: () => currentPath,
    async open(filePath) {
      const absolute = path.resolve(filePath);
      await command('load_document', { json: fs.readFileSync(absolute, 'utf8') });
      currentPath = absolute;
      savedHash = (await snapshot()).stateHash;
    },
    async save(filePath) {
      const target = filePath !== undefined ? path.resolve(filePath) : currentPath;
      if (target === null) throw new Error('no file chosen for this document (use Save As)');
      const current = await snapshot();
      writeDocumentFile(target, current.document);
      currentPath = target;
      savedHash = current.stateHash;
      return target;
    },
    async newDocument() {
      await command('clear_document', {}, true);
      currentPath = null;
      savedHash = (await snapshot()).stateHash;
    },
    async hasUnsavedChanges() {
      const current = await snapshot();
      return savedHash === null ? Object.keys(current.document.entities).length > 0 : current.stateHash !== savedHash;
    },
  };
}
