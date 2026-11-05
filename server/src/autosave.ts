/**
 * Debounced, atomic autosave writer. Transport/state glue only (architecture L6).
 *
 * - `schedule(doc)` coalesces bursts of mutations into one write after `debounceMs`. The debounced write is ASYNC
 *   (`fs.promises`, off the event loop) and writes never overlap: one in flight, the newest pending doc follows.
 * - Writes go to a fsynced temp file then `rename`, keeping the replaced autosave as `<file>.bak` (SC-D1), so a crash never leaves
 *   a truncated or missing autosave.
 * - A failed write (serialize, disk full, I/O) is reported through `onStatus` with a stable `DSF_*` code, retried with backoff, and
 *   reported ok again by the first success (A-11): the user is never left believing a failing autosave works.
 * - `flush()` writes any pending document SYNCHRONOUSLY (shutdown / uncaughtException) and supersedes an in-flight async
 *   write: that one drops its rename, so an older document can never land after a newer one.
 */

import fs from 'fs';
import { replaceKeepingBackupAsync, writeFileKeepingBackup } from './writeFileAtomic';
import path from 'path';
import { errorMessage } from '@lib/errorMessage';
import type { CadDocument } from '@core/model/types';

export type AutosaveFailureCode = 'DSF_SAVE_DISK_FULL' | 'DSF_SAVE_IO' | 'DSF_AUTOSAVE_FAILED';

export type AutosaveStatus = { readonly ok: true } | { readonly ok: false; readonly code: AutosaveFailureCode; readonly message: string };

/** Disk full / quota -> DSF_SAVE_DISK_FULL; any other file-system error -> DSF_SAVE_IO. */
export function writeFailureCode(err: unknown): AutosaveFailureCode {
  const code = typeof err === 'object' && err !== null && 'code' in err ? (err as { code: unknown }).code : undefined;
  return code === 'ENOSPC' || code === 'EDQUOT' ? 'DSF_SAVE_DISK_FULL' : 'DSF_SAVE_IO';
}

interface Autosaver {
  schedule(doc: CadDocument): void;
  flush(): void;
  /** Flush, then make every later `schedule` write synchronously (shutdown path). */
  stop(): void;
}

interface AutosaverOptions {
  filePath: string;
  debounceMs: number;
  serialize: (doc: CadDocument) => string;
  /** Called on every failure and when a later write succeeds again. */
  onStatus?: (status: AutosaveStatus) => void;
  /** Called after a document reached the disk. */
  onWritten?: (doc: CadDocument) => void;
  /** First retry delay after a failure (doubles up to 30 s); default 1000. */
  retryBaseMs?: number;
}

const RETRY_MAX_MS = 30_000;

/** A crash mid-write leaves `<file>.<pid>.async.tmp` from an earlier process; never read, so delete it at start. */
function removeStaleTemporaries(filePath: string): void {
  const prefix = `${path.basename(filePath)}.`;
  try {
    for (const name of fs.readdirSync(path.dirname(filePath)))
      if (name.startsWith(prefix) && /^\d+\.async\.tmp$/.test(name.slice(prefix.length)) && name !== `${prefix}${process.pid}.async.tmp`)
        fs.rmSync(path.join(path.dirname(filePath), name), { force: true });
  } catch {
    // Missing directory: nothing to clean.
  }
}

export function createAutosaver(options: AutosaverOptions): Autosaver {
  const { filePath, debounceMs, serialize } = options;
  const retryBaseMs = options.retryBaseMs ?? 1000;
  const asyncTemporary = `${filePath}.${process.pid}.async.tmp`;
  removeStaleTemporaries(filePath);
  let pending: CadDocument | null = null;
  let timer: NodeJS.Timeout | null = null;
  let retryTimer: NodeJS.Timeout | null = null;
  let stopped = false;
  let inFlight: Promise<void> | null = null;
  let inFlightDoc: CadDocument | null = null;
  let failedDoc: CadDocument | null = null; // last async write that failed and nothing newer has replaced
  let failures = 0; // consecutive failed writes
  let syncWrites = 0; // bumped by every synchronous write; an async write started before one must not rename

  const succeeded = (doc: CadDocument): void => {
    options.onWritten?.(doc);
    if (failures === 0) return;
    failures = 0;
    options.onStatus?.({ ok: true });
  };

  const failed = (code: AutosaveFailureCode, err: unknown): void => {
    failures += 1;
    console.warn(`[autosave] write failed (${code}): ${errorMessage(err)}`);
    options.onStatus?.({ ok: false, code, message: errorMessage(err) });
  };

  const writeAtomic = (doc: CadDocument): void => {
    syncWrites += 1;
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      writeFileKeepingBackup(filePath, serialize(doc));
      succeeded(doc);
    } catch (err) {
      failed(writeFailureCode(err), err);
      failedDoc = doc; // a failed synchronous write is retried like an async one (never left failing without a retry)
      scheduleRetry();
    }
  };

  const writeAsync = async (doc: CadDocument, text: string, generation: number): Promise<void> => {
    try {
      await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
      await fs.promises.writeFile(asyncTemporary, text, 'utf8');
      const stillWanted = (): boolean => generation === syncWrites; // a synchronous write since supersedes this one
      if (stillWanted()) {
        const handle = await fs.promises.open(asyncTemporary, 'r+');
        try {
          await handle.sync();
        } finally {
          await handle.close();
        }
      }
      if (await replaceKeepingBackupAsync(asyncTemporary, filePath, stillWanted)) succeeded(doc);
      else await fs.promises.rm(asyncTemporary, { force: true });
    } catch (err) {
      failed(writeFailureCode(err), err);
      // Kept for the retry and the shutdown flush (a newer edit supersedes it).
      if (generation === syncWrites) {
        failedDoc = doc;
        scheduleRetry();
      }
      await fs.promises.rm(asyncTemporary, { force: true }).catch(() => undefined);
    }
  };

  const startAsync = (): void => {
    if (pending === null || inFlight !== null) return;
    const doc = pending;
    pending = null;
    let text: string;
    try {
      text = serialize(doc);
    } catch (err) {
      failed('DSF_AUTOSAVE_FAILED', err);
      failedDoc = doc;
      scheduleRetry();
      return;
    }
    inFlightDoc = doc;
    inFlight = writeAsync(doc, text, syncWrites).finally(() => {
      inFlight = null;
      inFlightDoc = null;
      if (pending !== null && timer === null) startAsync();
    });
  };

  /** Retry the failed document with exponential backoff; a newer `schedule` supersedes it. */
  function scheduleRetry(): void {
    if (stopped || retryTimer !== null) return;
    retryTimer = setTimeout(
      () => {
        retryTimer = null;
        if (pending === null && failedDoc !== null) {
          pending = failedDoc;
          failedDoc = null;
        }
        startAsync();
      },
      Math.min(retryBaseMs * 2 ** Math.max(0, failures - 1), RETRY_MAX_MS),
    );
    retryTimer.unref();
  }

  const flush = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (retryTimer !== null) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    // An unfinished or failed async write is redone synchronously (shutdown must not lose it).
    const doc = pending ?? inFlightDoc ?? failedDoc;
    if (doc === null) return;
    pending = null;
    inFlightDoc = null;
    failedDoc = null;
    writeAtomic(doc);
  };

  return {
    schedule(doc: CadDocument): void {
      pending = doc;
      failedDoc = null;
      if (stopped) {
        flush();
        return;
      }
      if (timer !== null) return;
      timer = setTimeout(() => {
        timer = null;
        startAsync();
      }, debounceMs);
      timer.unref();
    },
    flush,
    stop(): void {
      stopped = true;
      flush();
    },
  };
}
