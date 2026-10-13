/**
 * Where the `llull` CLI runs a command: a local document file (offline, the registry in-process)
 * or a running llull server (`POST /command` on the shared live document, so the open app updates).
 * Transport glue only (L6): every change goes through `execute` here or the server's command bus.
 */

import fs from 'fs';
import path from 'path';
import { defaultContext } from '@core/commands/context';
import type { CadDocument } from '@core/model/types';
import { failedOutcome, runCommandOutcome } from '@mcp/commandOutcome';
import { parseCommandResponse, type CommandOutcome } from '@mcp/restProtocol';
import { errorMessage } from '@lib/errorMessage';
import type { StepObserver } from './progress';
import type { ExchangeOptions } from '../pythonExchange';
import { runLocalExchange } from './exchange';
import { requestJson, type FetchLike } from '../restClient';
import { readDocumentFile, writeDocumentFile } from '../documentFile';

export interface CliBackend {
  /** Human label: the document path or the server URL. */
  readonly target: string;
  run(name: string, params: unknown): Promise<CommandOutcome>;
  /** An exchange tool (export_step, import_step, import_dwg, import_code). */
  exchange(name: string, params: unknown): Promise<CommandOutcome>;
  /** Step back one change (local: swap with the `.bak` copy; server: `POST /undo`). */
  undo(): Promise<CommandOutcome>;
  /** Re-apply the undone change (local: the same swap; server: `POST /redo`). */
  redo(): Promise<CommandOutcome>;
}

/** The backup kept next to a local document before each save: one level of undo. */
function backupPathOf(docPath: string): string {
  return `${docPath}.bak`;
}

/** Save `doc` to `docPath`, keeping the previous file as `<docPath>.bak`. */
export function saveDocumentWithBackup(docPath: string, doc: CadDocument): void {
  if (fs.existsSync(docPath)) fs.copyFileSync(docPath, backupPathOf(docPath));
  writeDocumentFile(docPath, doc);
}

interface LocalOptions {
  /** Run and report, but never write the document file. */
  readonly dryRun: boolean;
  /** Watches `build_project` steps: progress lines, per-step timing, the `--timeout` deadline. */
  readonly observer?: StepObserver;
  /** Python / DWG ports for the exchange tools, created on first use. */
  readonly exchangeOptions: () => ExchangeOptions;
}

/** Offline backend over a document file: load, `execute`, save when the document changed. */
export function createLocalBackend(docPath: string, options: LocalOptions): CliBackend {
  let doc: CadDocument | null = null;
  const currentDoc = (): CadDocument => {
    doc ??= readDocumentFile(docPath);
    return doc;
  };
  const runCommand = (name: string, params: unknown): CommandOutcome => {
    try {
      const prior = currentDoc();
      const { document, outcome } = runCommandOutcome(
        prior,
        name,
        params,
        options.observer !== undefined ? { ...defaultContext(), onStep: options.observer.onStep } : undefined,
      );
      doc = document;
      if (outcome.changed && !options.dryRun) saveDocumentWithBackup(docPath, document);
      return outcome.data !== undefined ? { ...outcome, data: options.observer?.withDurations(outcome.data) ?? outcome.data } : outcome;
    } catch (error) {
      return failedOutcome(name, error);
    }
  };
  const swapWithBackup = (label: string): Promise<CommandOutcome> => {
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
    run: (name, params) => Promise.resolve(runCommand(name, params)),
    exchange: (name, params) =>
      runLocalExchange(name, params, {
        options: options.exchangeOptions(),
        getDoc: currentDoc,
        runCommand,
      }),
    undo: () => swapWithBackup('undo'),
    redo: () => swapWithBackup('redo'),
  };
}

/** A server that accepts the connection but never answers must not hang the CLI. */
const REMOTE_TIMEOUT_MS = 120_000;

interface RemoteOptions {
  readonly token: string | undefined;
  /** `--timeout` in seconds: how long one call may take (default 120 s). */
  readonly timeoutSeconds?: number;
  /** Injected for tests; the global `fetch` otherwise. */
  readonly fetchImpl?: FetchLike;
}

/** Backend over a running llull server: every call goes through its command bus (shared history). */
export function createRemoteBackend(serverUrl: string, options: RemoteOptions): CliBackend {
  const base = serverUrl.replace(/\/+$/, '');
  const timeoutMs = options.timeoutSeconds !== undefined ? options.timeoutSeconds * 1000 : REMOTE_TIMEOUT_MS;
  const post = async (route: string, body: unknown): Promise<CommandOutcome> => {
    try {
      const reply = await requestJson(`${base}${route}`, {
        body,
        token: options.token,
        timeoutMs,
        fetchImpl: options.fetchImpl,
      });
      return parseCommandResponse(reply.body, reply.status);
    } catch (error) {
      if (error instanceof Error && error.name === 'TimeoutError') {
        return {
          summary: `Timed out after ${timeoutMs / 1000}s waiting for the llull server at ${base}${options.timeoutSeconds !== undefined ? ' (--timeout)' : ''}; the server may still be running the command.`,
          affected: [],
          isError: true,
          changed: false,
        };
      }
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
    exchange: (name, params) => post('/exchange', { name, params }),
    undo: () => post('/undo', {}),
    redo: () => post('/redo', {}),
  };
}
