/** Where the CLI runs a command: a local document file (in-process registry) or a server's command bus. */
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
  readonly target: string; // document path or server URL
  run(name: string, params: unknown): Promise<CommandOutcome>;
  exchange(name: string, params: unknown): Promise<CommandOutcome>; // export_step, import_step, import_dwg, import_code
  /** Local: swap with the `.bak` copy (one level); server: `POST /undo` / `/redo`. */
  undo(): Promise<CommandOutcome>;
  redo(): Promise<CommandOutcome>;
}

/** Save `doc`, keeping the previous file as `<docPath>.bak` (one level of undo). */
export function saveDocumentWithBackup(docPath: string, doc: CadDocument): void {
  if (fs.existsSync(docPath)) fs.copyFileSync(docPath, `${docPath}.bak`);
  writeDocumentFile(docPath, doc);
}

interface LocalOptions {
  readonly dryRun: boolean;
  readonly observer?: StepObserver; // build_project progress, per-step timing, `--timeout`
  readonly exchangeOptions: () => ExchangeOptions; // created on first use
}

/** Offline backend: load, `execute`, save when the document changed. */
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
    const backup = `${docPath}.bak`;
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
    exchange: (name, params) => runLocalExchange(name, params, { options: options.exchangeOptions(), getDoc: currentDoc, runCommand }),
    undo: () => swapWithBackup('undo'),
    redo: () => swapWithBackup('redo'),
  };
}

const REMOTE_TIMEOUT_MS = 120_000; // a server that never answers must not hang the CLI

interface RemoteOptions {
  readonly token: string | undefined;
  readonly timeoutSeconds?: number; // `--timeout`, per call
  readonly fetchImpl?: FetchLike;
}

export function createRemoteBackend(serverUrl: string, options: RemoteOptions): CliBackend {
  const base = serverUrl.replace(/\/+$/, '');
  const timeoutMs = options.timeoutSeconds !== undefined ? options.timeoutSeconds * 1000 : REMOTE_TIMEOUT_MS;
  const post = async (route: string, body: unknown): Promise<CommandOutcome> => {
    try {
      const reply = await requestJson(`${base}${route}`, { body, token: options.token, timeoutMs, fetchImpl: options.fetchImpl });
      return parseCommandResponse(reply.body, reply.status);
    } catch (error) {
      const summary =
        error instanceof Error && error.name === 'TimeoutError'
          ? `Timed out after ${timeoutMs / 1000}s waiting for the llull server at ${base}${options.timeoutSeconds !== undefined ? ' (--timeout)' : ''}; the server may still be running the command.`
          : `Cannot reach the llull server at ${base}: ${errorMessage(error)} (start it with npm --prefix server run dev, or drop --server to work on a local file).`;
      return { summary, affected: [], isError: true, changed: false };
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
