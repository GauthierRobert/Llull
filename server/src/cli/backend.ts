/**
 * @layer server
 * Where the `llull` CLI runs a command: a local document file (offline, the registry in-process)
 * or a running llull server (`POST /command` on the shared live document, so the open app updates).
 * Transport glue only (L6): every change goes through `execute` here or the server's command bus.
 */

import fs from 'fs';
import path from 'path';
import { execute } from '@core/commands/registry';
import { serializeDocument, deserializeDocument } from '@core/commands/persistence/serialization';
import { type CadDocument, createEmptyDocument } from '@core/model/types';
import { errorMessage } from '@lib/errorMessage';
import { isRecord } from '@lib/isRecord';

/** One command outcome, the same shape whichever backend ran it. */
export interface CliRunResult {
  readonly summary: string;
  readonly affected: readonly string[];
  readonly isError: boolean;
  /** The document was replaced (and saved, for a local backend not in dry-run). */
  readonly changed: boolean;
  readonly data?: unknown;
}

export interface CliBackend {
  /** Human label: the document path or the server URL. */
  readonly target: string;
  run(name: string, params: unknown): Promise<CliRunResult>;
  /** Step back one change (local: swap with the `.bak` copy; server: `POST /undo`). */
  undo(): Promise<CliRunResult>;
  /** Re-apply the undone change (local: the same swap; server: `POST /redo`). */
  redo(): Promise<CliRunResult>;
}

/** The backup kept next to a local document before each save: one level of undo. */
export function backupPathOf(docPath: string): string {
  return `${docPath}.bak`;
}

function writeAtomic(filePath: string, text: string): void {
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, text, 'utf8');
  fs.renameSync(temporary, filePath);
}

/** The document stored at `docPath`; an empty document when the file does not exist yet. */
export function readDocumentFile(docPath: string): CadDocument {
  if (!fs.existsSync(docPath)) return createEmptyDocument();
  return deserializeDocument(fs.readFileSync(docPath, 'utf8'));
}

/** Save `doc` to `docPath`, keeping the previous file as `<docPath>.bak`. */
export function writeDocumentFile(docPath: string, doc: CadDocument): void {
  fs.mkdirSync(path.dirname(path.resolve(docPath)), { recursive: true });
  if (fs.existsSync(docPath)) fs.copyFileSync(docPath, backupPathOf(docPath));
  writeAtomic(docPath, serializeDocument(doc));
}

interface LocalOptions {
  /** Run and report, but never write the document file. */
  readonly dryRun: boolean;
}

/** Offline backend over a document file: load, `execute`, save when the document changed. */
export function createLocalBackend(docPath: string, options: LocalOptions): CliBackend {
  let doc: CadDocument | null = null;
  const swapWithBackup = (label: string): Promise<CliRunResult> => {
    const backup = backupPathOf(docPath);
    if (!fs.existsSync(backup)) {
      return Promise.resolve({
        summary: `Nothing to ${label}: no ${path.basename(backup)} next to the document.`,
        affected: [],
        isError: false,
        changed: false,
      });
    }
    if (!options.dryRun) {
      // Park the current file first: a crash at any point leaves both versions on disk.
      const parked = `${docPath}.${process.pid}.swap`;
      const hasCurrent = fs.existsSync(docPath);
      if (hasCurrent) fs.copyFileSync(docPath, parked);
      fs.renameSync(backup, docPath);
      if (hasCurrent) fs.renameSync(parked, backup);
    }
    return Promise.resolve({
      summary: `${label}: swapped ${docPath} with its previous version (${path.basename(backup)}).`,
      affected: [],
      isError: false,
      changed: !options.dryRun,
    });
  };
  return {
    target: docPath,
    run(name, params) {
      try {
        const prior = doc ?? readDocumentFile(docPath);
        const result = execute(prior, name, params);
        const changed = result.document !== prior;
        doc = result.document;
        if (changed && !options.dryRun) writeDocumentFile(docPath, result.document);
        return Promise.resolve({
          summary: result.summary,
          affected: result.affected,
          isError: result.rejected === true,
          changed,
          ...(result.data !== undefined ? { data: result.data } : {}),
        });
      } catch (error) {
        return Promise.resolve({
          summary: `Command ${name} failed: ${errorMessage(error)}`,
          affected: [],
          isError: true,
          changed: false,
        });
      }
    },
    undo: () => swapWithBackup('undo'),
    redo: () => swapWithBackup('redo'),
  };
}

/** A `CliRunResult` out of a server JSON body (the command bus result shape). */
function resultOfBody(body: unknown, status: number): CliRunResult {
  if (!isRecord(body) || typeof body['summary'] !== 'string') {
    const message = isRecord(body) && typeof body['error'] === 'string' ? body['error'] : '';
    return {
      summary: `Server answered HTTP ${status}${message !== '' ? `: ${message}` : ''}.`,
      affected: [],
      isError: true,
      changed: false,
    };
  }
  const affected = Array.isArray(body['affected'])
    ? body['affected'].filter((id): id is string => typeof id === 'string')
    : [];
  return {
    summary: body['summary'],
    affected,
    isError: body['isError'] === true || status >= 400,
    changed: body['changed'] === true,
    ...(body['data'] !== undefined ? { data: body['data'] } : {}),
  };
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** A server that accepts the connection but never answers must not hang the CLI. */
const REMOTE_TIMEOUT_MS = 120_000;

interface RemoteOptions {
  readonly token: string | undefined;
  /** Injected for tests; the global `fetch` otherwise. */
  readonly fetchImpl?: FetchLike;
}

/** Backend over a running llull server: every call goes through its command bus (shared history). */
export function createRemoteBackend(serverUrl: string, options: RemoteOptions): CliBackend {
  const base = serverUrl.replace(/\/+$/, '');
  const fetchImpl: FetchLike = options.fetchImpl ?? ((url, init) => fetch(url, init));
  const post = async (route: string, body: unknown): Promise<CliRunResult> => {
    try {
      const response = await fetchImpl(`${base}${route}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(options.token !== undefined ? { Authorization: `Bearer ${options.token}` } : {}),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REMOTE_TIMEOUT_MS),
      });
      const text = await response.text();
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(text) as unknown;
      } catch {
        parsed = { error: text.slice(0, 200) };
      }
      return resultOfBody(parsed, response.status);
    } catch (error) {
      return {
        summary: `Cannot reach the llull server at ${base}: ${errorMessage(error)} (start it with npm --prefix server run dev, or drop --server to work on a local file).`,
        affected: [],
        isError: true,
        changed: false,
      };
    }
  };
  return {
    target: base,
    run: (name, params) => post('/command', { name, params }),
    undo: () => post('/undo', {}),
    redo: () => post('/redo', {}),
  };
}
