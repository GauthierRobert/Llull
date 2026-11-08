/** Where the CLI runs a command: a local document file (in-process registry) or a server's command bus. */
import fs from 'fs';
import path from 'path';
import type { CadDocument } from '@core/model/types';
import { failedOutcome } from '@protocol/commandOutcome';
import { parseCommandResponse, type CommandOutcome } from '@protocol/restProtocol';
import { errorMessage } from '@lib/errorMessage';
import type { StepObserver } from './progress';
import type { ExchangeOptions } from '../pythonExchange';
import { runLocalExchange } from './exchange';
import { requestCommandStream, requestJson, type FetchLike } from '../restClient';
import { deferralCount } from '@core/geometry/mesh/engine';
import type { PlanStepEvent } from '@core/commands/types';
import { runHostCommand, runHostCommandResolved } from '../plm/hostRun';
import { formatJobProgress, formatStreamedProgress } from './progress';
import { type FileStamp, readDocumentFile, SaveConflictError, stampOf, writeDocumentFile } from '../documentFile';
import { acquireDocumentLock, DocumentLockedError } from '../documentLock';
import { renameWithRetry } from '../writeFileAtomic';

export interface CliBackend {
  readonly target: string; // document path or server URL
  run(name: string, params: unknown): Promise<CommandOutcome>;
  exchange(name: string, params: unknown): Promise<CommandOutcome>; // export_step, import_step, import_dwg, import_code
  /** Local: swap with the `.bak` copy (one level); server: `POST /undo` / `/redo`. */
  undo(): Promise<CommandOutcome>;
  redo(): Promise<CommandOutcome>;
}

/** Save `doc`, keeping the previous file as `<docPath>.bak` (one level of undo): every document save does (`writeDocumentFile`). */
export function saveDocumentWithBackup(docPath: string, doc: CadDocument): void {
  writeDocumentFile(docPath, doc);
}

/** A refusal the host decided (lock, conflict): a failed outcome with a machine-readable code, nothing written. */
function refusedOutcome(code: string, summary: string, documentPath: string, remediation: string): CommandOutcome {
  return { summary, affected: [], isError: true, changed: false, error: { code, ids: [], paths: [documentPath], remediation } };
}

const LOCKED_REMEDIATION = 'Use --app for the open document, or retry when the other writer is done.';

interface LocalOptions {
  readonly dryRun: boolean;
  /** Save even though the file changed on disk since it was loaded (--force-overwrite). */
  readonly forceOverwrite?: boolean;
  readonly observer?: StepObserver; // build_project progress, per-step timing, `--timeout`
  readonly exchangeOptions: () => ExchangeOptions; // created on first use
  /** Ctrl-C: cancels the command in flight (its native mesh jobs are killed, nothing is saved). */
  readonly signal?: AbortSignal;
  readonly armInterrupt?: () => () => void;
}

/**
 * `onStep` of a plan that runs again after each native mesh job (TECHNICAL_SPEC 13.8): a step is reported once, as it ended in the run that stands.
 * Events of steps already reported are dropped, and so is everything a run reports after it asked for a job (the step that asked ended deferred, not
 * failed, and the steps after it work on a placeholder). A run begins at ordinal 1.
 */
function onceOnly(onStep: (event: PlanStepEvent) => void): (event: PlanStepEvent) => void {
  let ended = 0;
  let started = 0;
  let baseline = deferralCount();
  return (event) => {
    if (event.phase === 'start' && event.ordinal === 1) baseline = deferralCount();
    if (deferralCount() !== baseline) return;
    if (event.phase === 'start') {
      if (event.ordinal <= started) return;
      started = event.ordinal;
      return onStep(event);
    }
    if (event.ordinal <= ended) return;
    ended = event.ordinal;
    onStep(event);
  };
}

/** Offline backend: load, `execute`, save when the document changed. */
export function createLocalBackend(docPath: string, options: LocalOptions): CliBackend {
  let doc: CadDocument | null = null;
  let loadedStamp: FileStamp | null = null; // the file as this process loaded / last saved it (DSF_SAVE_CONFLICT)
  const currentDoc = (): CadDocument => {
    if (doc === null) {
      loadedStamp = stampOf(docPath); // before the read: a change in between is caught at save time
      doc = readDocumentFile(docPath);
    }
    return doc;
  };
  /**
   * The write path of every local save (A-09): the lock next to the file (DSF_DOC_LOCKED; a dead holder's lock is taken over and
   * reported as DSF_LOCK_STALE), then the on-disk check against what was loaded (DSF_SAVE_CONFLICT unless --force-overwrite).
   */
  const saveGuarded = (document: CadDocument): { refusal: CommandOutcome } | { note: string | null } => {
    try {
      const lock = acquireDocumentLock(docPath, 'cli'); // held for the write only: a CLI call is one load-modify-save
      try {
        loadedStamp = writeDocumentFile(docPath, document, options.forceOverwrite === true ? undefined : { stamp: loadedStamp });
      } finally {
        lock.release();
      }
      const notes = [
        lock.tookOver === null ? null : `DSF_LOCK_STALE: took over the lock left by pid ${lock.tookOver.pid} (no longer running).`,
        lock.warning === null
          ? null
          : `${lock.warning}: this folder takes no lock file; ${path.basename(docPath)} was written without one.`,
      ].filter((note): note is string => note !== null);
      return { note: notes.length === 0 ? null : notes.join(' ') };
    } catch (error) {
      if (error instanceof DocumentLockedError) return { refusal: refusedOutcome(error.code, error.message, docPath, LOCKED_REMEDIATION) };
      if (error instanceof SaveConflictError)
        return { refusal: refusedOutcome(error.code, error.message, docPath, 'Reload the file, or pass --force-overwrite to replace it.') };
      throw error;
    }
  };
  const finished = (document: CadDocument, outcome: CommandOutcome): CommandOutcome => {
    let result = outcome;
    if (outcome.changed && !options.dryRun) {
      const saved = saveGuarded(document);
      if ('refusal' in saved) return saved.refusal; // nothing written: the in-memory document is not adopted
      if (saved.note !== null) result = { ...outcome, summary: `${outcome.summary} ${saved.note}` };
    }
    doc = document;
    return result.data !== undefined ? { ...result, data: options.observer?.withDurations(result.data) ?? result.data } : result;
  };
  /** The host's fixed commands (exchange follow-ups): synchronous, never a native mesh job. */
  const runFixed = (name: string, params: unknown): CommandOutcome => {
    try {
      const { document, outcome } = runHostCommand(currentDoc(), name, params, { source: 'cli' });
      return finished(document, outcome);
    } catch (error) {
      return failedOutcome(name, error);
    }
  };
  /** Any command; a native mesh job is awaited with progress lines (`--progress`) and Ctrl-C cancels it. */
  const runResolved = async (name: string, params: unknown): Promise<CommandOutcome> => {
    let disarm: (() => void) | undefined;
    try {
      const { document, outcome } = await runHostCommandResolved(currentDoc, name, params, {
        source: 'cli',
        ...(options.observer !== undefined ? { onStep: onceOnly(options.observer.onStep) } : {}),
        onProgress: (event) => options.observer?.note(formatJobProgress(event)),
        // Ctrl-C is heard only while a job is awaited: a synchronous run blocks the loop, and there the OS default must still end the process
        onWaitStart: () => {
          disarm = options.armInterrupt?.();
        },
        onWaitEnd: () => {
          disarm?.();
          disarm = undefined;
        },
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
      });
      return finished(document, outcome);
    } catch (error) {
      return failedOutcome(name, error);
    } finally {
      disarm?.();
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
      let lock: ReturnType<typeof acquireDocumentLock>;
      try {
        lock = acquireDocumentLock(docPath, 'cli');
      } catch (error) {
        if (error instanceof DocumentLockedError)
          return Promise.resolve(refusedOutcome(error.code, error.message, docPath, LOCKED_REMEDIATION));
        throw error;
      }
      try {
        // Park the current file first: a crash at any point leaves both versions on disk.
        const parked = `${docPath}.${process.pid}.swap`;
        const hasCurrent = fs.existsSync(docPath);
        if (hasCurrent) fs.copyFileSync(docPath, parked);
        renameWithRetry(backup, docPath);
        if (hasCurrent) renameWithRetry(parked, backup);
      } finally {
        lock.release();
      }
      doc = null; // the file is another version now: the next load re-reads it and its stamp
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
    run: runResolved,
    exchange: (name, params) =>
      runLocalExchange(name, params, {
        options: options.exchangeOptions(),
        getDoc: currentDoc,
        runCommand: runFixed,
        ...(options.observer !== undefined ? { onProgress: options.observer.note } : {}),
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
      }),
    undo: () => swapWithBackup('undo'),
    redo: () => swapWithBackup('redo'),
  };
}

const REMOTE_TIMEOUT_MS = 120_000; // a server that never answers must not hang the CLI

interface RemoteOptions {
  readonly token: string | undefined;
  readonly timeoutSeconds?: number; // `--timeout`, per call
  readonly fetchImpl?: FetchLike;
  /** Lines of a native mesh job the server runs (`--progress`). */
  readonly onJobProgress?: (line: string) => void;
  /** Ctrl-C: the connection closes, the server cancels the command. */
  readonly signal?: AbortSignal;
  readonly armInterrupt?: () => () => void;
}

export function createRemoteBackend(serverUrl: string, options: RemoteOptions): CliBackend {
  const base = serverUrl.replace(/\/+$/, '');
  const timeoutMs = options.timeoutSeconds !== undefined ? options.timeoutSeconds * 1000 : REMOTE_TIMEOUT_MS;
  const answer = async (send: () => Promise<{ readonly body: unknown; readonly status: number }>): Promise<CommandOutcome> => {
    try {
      const reply = await send();
      return parseCommandResponse(reply.body, reply.status);
    } catch (error) {
      if (options.signal?.aborted === true)
        return {
          summary:
            'llull: cancelled (Ctrl-C). The server was asked to stop the command; nothing is applied if it had not committed yet. Check the document with `llull exec describe_scene --app` (or --server URL), or GET /live/snapshot.',
          affected: [],
          isError: true,
          changed: false,
        };
      const summary =
        error instanceof Error && error.name === 'TimeoutError'
          ? `Timed out after ${timeoutMs / 1000}s waiting for the llull server at ${base}${options.timeoutSeconds !== undefined ? ' (--timeout)' : ''}; the server may still be running the command.`
          : `Cannot reach the llull server at ${base}: ${errorMessage(error)} (start it with npm --prefix server run dev, or drop --server to work on a local file).`;
      return { summary, affected: [], isError: true, changed: false };
    }
  };
  const post = (route: string, body: unknown): Promise<CommandOutcome> =>
    answer(() => requestJson(`${base}${route}`, { body, token: options.token, timeoutMs, fetchImpl: options.fetchImpl }));
  /** `POST /command` read as a stream: the server reports a native mesh job as it runs, and answers when the command is done. */
  const postCommand = async (body: unknown): Promise<CommandOutcome> => {
    const disarm = options.armInterrupt?.();
    try {
      return await streamCommand(body);
    } finally {
      disarm?.();
    }
  };
  const streamCommand = (body: unknown): Promise<CommandOutcome> =>
    answer(() =>
      requestCommandStream(`${base}/command`, {
        body,
        token: options.token,
        idleTimeoutMs: timeoutMs,
        totalTimeoutMs: options.timeoutSeconds !== undefined ? timeoutMs : undefined,
        signal: options.signal,
        fetchImpl: options.fetchImpl,
        onProgress: (event) => options.onJobProgress?.(formatStreamedProgress(event)),
      }),
    );
  return {
    target: base,
    run: (name, params) => postCommand({ name, params, client: 'cli' }),
    exchange: (name, params) => post('/exchange', { name, params, client: 'cli' }),
    undo: () => post('/undo', {}),
    redo: () => post('/redo', {}),
  };
}
