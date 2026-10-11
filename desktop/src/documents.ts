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
import { serializeDocument } from '@core/commands/persistence/serialization';
import type { CadDocument } from '@core/model/types';
import { isRecord } from '@lib/isRecord';

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

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

function writeAtomic(filePath: string, text: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, text, 'utf8');
  fs.renameSync(temporary, filePath);
}

/** The JSON body, or null for a non-JSON answer (proxy error page, crash): callers report the status. */
async function jsonOf(response: Response): Promise<unknown> {
  try {
    return (await response.json()) as unknown;
  } catch {
    return null;
  }
}

export function createDocumentSession(options: SessionOptions): DocumentSession {
  const fetchImpl: FetchLike = options.fetchImpl ?? ((url, init) => fetch(url, init));
  const auth = { Authorization: `Bearer ${options.token}` };
  let currentPath: string | null = null;
  let savedHash: string | null = null;

  const snapshot = async (): Promise<Snapshot> => {
    const response = await fetchImpl(`${options.url}/live/snapshot`, { headers: auth });
    const body = await jsonOf(response);
    if (!response.ok || !isRecord(body) || typeof body['stateHash'] !== 'string')
      throw new Error(`cannot read the document from the backend (HTTP ${response.status})`);
    return { stateHash: body['stateHash'], document: body['document'] as CadDocument };
  };

  /** POST /command; `mayNoop`: a command that changes nothing is fine (clearing an empty doc). */
  const command = async (name: string, params: unknown, mayNoop = false): Promise<void> => {
    const response = await fetchImpl(`${options.url}/command`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, params }),
    });
    const body = await jsonOf(response);
    const summary = isRecord(body) && typeof body['summary'] === 'string' ? body['summary'] : '';
    if (
      !response.ok ||
      !isRecord(body) ||
      body['isError'] === true ||
      (!mayNoop && body['changed'] === false)
    ) {
      const error = isRecord(body) && typeof body['error'] === 'string' ? body['error'] : summary;
      throw new Error(error !== '' ? error : `${name} failed (HTTP ${response.status})`);
    }
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
      writeAtomic(target, serializeDocument(current.document));
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
