/**
 * Debounced, atomic autosave writer. Transport/state glue only (architecture L6).
 *
 * - `schedule(doc)` coalesces bursts of mutations into one write after `debounceMs`. The debounced write is ASYNC
 *   (`fs.promises`, off the event loop) and writes never overlap: one in flight, the newest pending doc follows.
 * - Writes go to a fsynced temp file then `rename`, keeping the replaced autosave as `<file>.bak` (SC-D1), so a crash never leaves
 *   a truncated or missing autosave.
 * - `flush()` writes any pending document SYNCHRONOUSLY (shutdown / uncaughtException) and supersedes an in-flight async
 *   write: that one drops its rename, so an older document can never land after a newer one.
 */

import fs from 'fs';
import { replaceKeepingBackup, writeFileKeepingBackup } from './writeFileAtomic';
import path from 'path';
import { errorMessage } from '@lib/errorMessage';
import type { CadDocument } from '@core/model/types';

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
}

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
  const asyncTemporary = `${filePath}.${process.pid}.async.tmp`;
  removeStaleTemporaries(filePath);
  let pending: CadDocument | null = null;
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;
  let inFlight: Promise<void> | null = null;
  let inFlightDoc: CadDocument | null = null;
  let failedDoc: CadDocument | null = null; // last async write that failed and nothing newer has replaced
  let syncWrites = 0; // bumped by every synchronous write; an async write started before one must not rename

  const writeAtomic = (doc: CadDocument): void => {
    syncWrites += 1;
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      writeFileKeepingBackup(filePath, serialize(doc));
    } catch (err) {
      console.warn(`[autosave] write failed: ${errorMessage(err)}`);
    }
  };

  const writeAsync = async (doc: CadDocument, text: string, generation: number): Promise<void> => {
    try {
      await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
      await fs.promises.writeFile(asyncTemporary, text, 'utf8');
      const handle = await fs.promises.open(asyncTemporary, 'r+');
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
      if (generation === syncWrites) replaceKeepingBackup(asyncTemporary, filePath);
      else await fs.promises.rm(asyncTemporary, { force: true });
    } catch (err) {
      console.warn(`[autosave] write failed: ${errorMessage(err)}`);
      // Kept for the shutdown flush (a newer edit supersedes it); no immediate retry, which would spin on a full disk.
      if (generation === syncWrites) failedDoc = doc;
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
      console.warn(`[autosave] write failed: ${errorMessage(err)}`);
      return;
    }
    inFlightDoc = doc;
    inFlight = writeAsync(doc, text, syncWrites).finally(() => {
      inFlight = null;
      inFlightDoc = null;
      if (pending !== null && timer === null) startAsync();
    });
  };

  const flush = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
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
