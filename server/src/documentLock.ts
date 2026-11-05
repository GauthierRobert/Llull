/**
 * The lock file next to a document (A-09, FR-DSF-13..15): `<file>.llull-lock`, JSON `{ pid, host, user, app, since }`, taken by whichever
 * process opens the file for writing (the desktop app, or the CLI on `--doc` at its first write). A second writer is refused with
 * DSF_DOC_LOCKED. A lock whose pid is dead on THIS host is taken over (DSF_LOCK_STALE is reported to the caller); a lock of another host is
 * never taken, whatever its age (the holder may be alive on a share). Released on normal exit and by `release()`; a crash leaves it behind,
 * which is exactly the stale case.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { isRecord } from '@lib/isRecord';

export interface LockInfo {
  readonly pid: number;
  readonly host: string;
  readonly user: string;
  readonly app: 'desktop' | 'cli';
  /** ISO time the lock was taken. */
  readonly since: string;
}

export type LockApp = LockInfo['app'];

export class DocumentLockedError extends Error {
  readonly code = 'DSF_DOC_LOCKED';
  constructor(
    readonly documentPath: string,
    readonly holder: LockInfo | null,
  ) {
    super(lockedMessage(documentPath, holder));
    this.name = 'DocumentLockedError';
  }
}

function lockedMessage(documentPath: string, holder: LockInfo | null): string {
  const base = path.basename(documentPath);
  if (holder === null) return `DSF_DOC_LOCKED: ${base} is locked by another llull process.`;
  const who = `pid ${holder.pid} on ${holder.host} since ${holder.since}`;
  return holder.app === 'desktop'
    ? `DSF_DOC_LOCKED: ${base} is open in the llull desktop app (${who}). Use --app to edit the open document, or close it there first.`
    : `DSF_DOC_LOCKED: ${base} is being edited by another llull command (${who}). Retry when it ends.`;
}

export interface DocumentLock {
  readonly documentPath: string;
  /** The holder of a stale lock that was taken over (DSF_LOCK_STALE), else null. */
  readonly tookOver: LockInfo | null;
  release(): void;
}

export const lockPathOf = (documentPath: string): string => `${path.resolve(documentPath)}.llull-lock`;

function parseLock(text: string): LockInfo | null {
  try {
    const value: unknown = JSON.parse(text);
    if (!isRecord(value)) return null;
    const { pid, host, user, app, since } = value;
    if (typeof pid !== 'number' || typeof host !== 'string' || typeof user !== 'string' || typeof since !== 'string') return null;
    if (app !== 'desktop' && app !== 'cli') return null;
    return { pid, host, user, app, since };
  } catch {
    return null;
  }
}

function readLock(lockPath: string): LockInfo | null {
  try {
    return parseLock(fs.readFileSync(lockPath, 'utf8'));
  } catch {
    return null;
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

const sameHolder = (a: LockInfo, b: LockInfo): boolean => a.pid === b.pid && a.host === b.host && a.since === b.since;

const held = new Map<string, LockInfo>();
let exitHookInstalled = false;

function releaseFile(lockPath: string, mine: LockInfo): void {
  const current = readLock(lockPath);
  if (current !== null && sameHolder(current, mine)) fs.rmSync(lockPath, { force: true });
}

function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on('exit', releaseAllDocumentLocks);
}

/** Release every lock this process holds (also runs at process exit). */
export function releaseAllDocumentLocks(): void {
  for (const [lockPath, info] of held) {
    try {
      releaseFile(lockPath, info);
    } catch {
      // The folder is gone: nothing left to release.
    }
  }
  held.clear();
}

/** Create the lock file only if it does not exist (hard-link of a private temp: atomic and exclusive on POSIX and NTFS). */
function createExclusive(lockPath: string, info: LockInfo): boolean {
  const staged = `${lockPath}.${process.pid}.tmp`;
  fs.writeFileSync(staged, JSON.stringify(info), 'utf8');
  try {
    fs.linkSync(staged, lockPath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  } finally {
    fs.rmSync(staged, { force: true });
  }
}

/**
 * Take the lock of `documentPath` for this process. Re-entrant for the same process.
 * @failure held by a live process, or by another host -> DocumentLockedError (DSF_DOC_LOCKED); the file is untouched
 */
export function acquireDocumentLock(documentPath: string, app: LockApp): DocumentLock {
  const resolved = path.resolve(documentPath);
  const lockPath = lockPathOf(resolved);
  const mine: LockInfo = { pid: process.pid, host: os.hostname(), user: os.userInfo().username, app, since: new Date().toISOString() };
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  let tookOver: LockInfo | null = null;
  const ours = held.get(lockPath);
  const present = readLock(lockPath);
  if (ours !== undefined && present !== null && sameHolder(present, ours)) return handle(resolved, lockPath, ours, null);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (createExclusive(lockPath, mine)) {
      held.set(lockPath, mine);
      installExitHook();
      return handle(resolved, lockPath, mine, tookOver);
    }
    const holder = readLock(lockPath);
    if (holder === null && fs.existsSync(lockPath)) throw new DocumentLockedError(resolved, null); // unreadable: never guess
    if (holder === null) continue; // vanished between the two calls: try again
    if (holder.host !== mine.host || processIsAlive(holder.pid)) throw new DocumentLockedError(resolved, holder);
    if (!removeStale(lockPath, holder)) throw new DocumentLockedError(resolved, readLock(lockPath));
    tookOver = holder;
  }
  throw new DocumentLockedError(resolved, readLock(lockPath));
}

/** Remove the lock of a dead holder. Renames it aside first so only one taker wins; a lock that is no longer the stale one is put back. */
function removeStale(lockPath: string, stale: LockInfo): boolean {
  const aside = `${lockPath}.${process.pid}.stale`;
  try {
    fs.renameSync(lockPath, aside);
  } catch {
    return false;
  }
  const moved = readLock(aside);
  if (moved !== null && sameHolder(moved, stale)) {
    fs.rmSync(aside, { force: true });
    return true;
  }
  try {
    fs.linkSync(aside, lockPath); // someone else's fresh lock: restore it
  } catch {
    // another one was created meanwhile: theirs stands
  }
  fs.rmSync(aside, { force: true });
  return false;
}

function handle(documentPath: string, lockPath: string, info: LockInfo, tookOver: LockInfo | null): DocumentLock {
  return {
    documentPath,
    tookOver,
    release() {
      held.delete(lockPath);
      releaseFile(lockPath, info);
    },
  };
}
