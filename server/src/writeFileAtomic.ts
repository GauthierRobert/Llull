/**
 * Crash-safe file replacement shared by the autosaver, the CLI, desktop discovery and the desktop
 * app: the one atomic writer.
 *
 * Document saves keep the replaced file as `<file>.bak` (SC-D1). Order, so that a kill at any instant leaves `<file>` complete
 * (old or new) and `<file>.bak` complete (previous backup or the old file):
 *   1. write `<file>.<pid>.tmp`, fsync
 *   2. hard-link (or copy + fsync) `<file>` to `<file>.<pid>.bak.tmp`, rename it over `<file>.bak`
 *   3. rename the temp over `<file>`
 * `<file>` is never missing: the old version is never moved away, only replaced by a rename. The `.bak` is the same file the
 * CLI's one-level `llull undo` swaps with, so "undo" after any save returns to the previous saved version.
 */

import fs from 'fs';
import path from 'path';

/** Windows: antivirus / indexers / a reader holding the file make a rename fail transiently. */
const TRANSIENT_RENAME_CODES: ReadonlySet<string> = new Set(['EPERM', 'EBUSY', 'EACCES']);
const RENAME_ATTEMPTS = 8;

const sleepSync = (ms: number): void => void Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** `fs.renameSync`, retried with a short backoff on a transient Windows sharing error. */
export function renameWithRetry(from: string, to: string): void {
  for (let attempt = 1; ; attempt++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? '';
      if (attempt >= RENAME_ATTEMPTS || !TRANSIENT_RENAME_CODES.has(code)) throw error;
      sleepSync(10 * attempt);
    }
  }
}

/** Write `text` to `filePath` and flush it to the disk. */
function writeDurably(filePath: string, text: string, mode?: number): void {
  const descriptor = fs.openSync(filePath, 'w', mode);
  try {
    fs.writeFileSync(descriptor, text, 'utf8');
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

/**
 * Write `text` to a sibling temp file, then rename it over `filePath` (atomic on POSIX and on NTFS). The temp
 * file is removed when the write fails; the error propagates.
 */
export function writeFileAtomic(filePath: string, text: string, mode?: number): void {
  const temporary = `${filePath}.${process.pid}.tmp`;
  try {
    writeDurably(temporary, text, mode);
    renameWithRetry(temporary, filePath);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}

/** Point `<file>.bak` at the current `<file>` (no-op when there is none), atomically: link/copy to a temp, rename over the backup. */
function backupCurrent(filePath: string): void {
  if (!fs.existsSync(filePath)) return;
  const staged = `${filePath}.${process.pid}.bak.tmp`;
  fs.rmSync(staged, { force: true });
  try {
    try {
      fs.linkSync(filePath, staged);
    } catch {
      // No hard links (FAT, some network shares): a durable copy instead.
      fs.copyFileSync(filePath, staged);
      const descriptor = fs.openSync(staged, 'r+');
      try {
        fs.fsyncSync(descriptor);
      } finally {
        fs.closeSync(descriptor);
      }
    }
    renameWithRetry(staged, `${filePath}.bak`);
  } catch (error) {
    fs.rmSync(staged, { force: true });
    throw error;
  }
}

/**
 * Move an already written + fsynced `temporary` into place at `filePath`, keeping the replaced file as `<file>.bak`.
 * @failure the backup or the rename fails -> throws; `filePath` still holds the old version
 */
export function replaceKeepingBackup(temporary: string, filePath: string): void {
  backupCurrent(filePath);
  renameWithRetry(temporary, filePath);
}

/** `writeFileAtomic`, keeping the replaced file as `<file>.bak` (document saves). */
export function writeFileKeepingBackup(filePath: string, text: string): void {
  removeOrphanedTemporaries(filePath);
  const temporary = `${filePath}.${process.pid}.tmp`;
  try {
    writeDurably(temporary, text);
    replaceKeepingBackup(temporary, filePath);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** A process killed mid-save leaves `<file>.<pid>.tmp` / `<file>.<pid>.bak.tmp`: never read; removed once that process is gone. */
function removeOrphanedTemporaries(filePath: string): void {
  const prefix = `${path.basename(filePath)}.`;
  let names: string[];
  try {
    names = fs.readdirSync(path.dirname(filePath));
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    const match = /^(\d+)\.(?:bak\.)?tmp$/.exec(name.slice(prefix.length));
    const pid = Number(match?.[1]);
    if (match !== null && pid !== process.pid && !processIsAlive(pid)) fs.rmSync(path.join(path.dirname(filePath), name), { force: true });
  }
}
