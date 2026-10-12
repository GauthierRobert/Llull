/**
 * @layer desktop
 * File ⇄ live document for the desktop menus. Every change goes through the backend's command
 * bus (`load_document`, `clear_document` via POST /command — undoable, broadcast to the window);
 * Save reads `GET /live/snapshot` and writes `serializeDocument` (the format the CLI's --doc reads).
 * Unsaved changes = the snapshot's stateHash differs from the one recorded at the last open/save
 * (selection is not part of the hash, so selecting does not mark the document dirty).
 */

import fs from 'fs';
import path from 'path';
import type { CadDocument } from '@core/model/types';
import { isRecord } from '@lib/isRecord';
import { outcomeIsFailure } from '@mcp/commandOutcome';
import { parseCommandResponse } from '@mcp/restProtocol';
import { requestJson, type FetchLike } from '@server/restClient';
import { writeDocumentFile } from '@server/documentFile';

interface Snapshot {
  readonly stateHash: string;
  readonly document: CadDocument;
}

export interface DocumentSession {
  /** Absolute path of the open file, or null for an unsaved document. */
  readonly currentPath: () => string | null;
  open(filePath: string): Promise<void>;
  /** Save to `filePath` (Save As) or to the current path. @failure no path -> rejects */
  save(filePath?: string): Promise<string>;
  /** Replace the document with an empty one (undoable in the app). */
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
    const { ok, status, body } = await requestJson(`${options.url}/live/snapshot`, {
      token: options.token,
      fetchImpl: options.fetchImpl,
    });
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
      if (savedHash === null) return Object.keys(current.document.entities).length > 0;
      return current.stateHash !== savedHash;
    },
  };
}
