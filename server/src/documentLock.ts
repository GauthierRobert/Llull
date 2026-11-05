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
  if (holder === null)
    return (
      `DSF_DOC_LOCKED: ${base} has a lock file llull cannot read (${lockPathOf(documentPath)}). ` +
      'If no llull is running, delete that file and try again.'
    );
  const who = `pid ${holder.pid} on ${holder.host} since ${holder.since}`;
  return holder.app === 'desktop'
    ? `DSF_DOC_LOCKED: ${base} is open in the llull desktop app (${who}). Use --app to edit the open document, or close it there first.`
    : `DSF_DOC_LOCKED: ${base} is being edited by another llull command (${who}). Retry when it ends.`;
}

export interface DocumentLock {
  readonly documentPath: string;
  /** The holder of a stale lock that was taken over (DSF_LOCK_STALE), else null. */
  readonly tookOver: LockInfo | null;
  /** The folder takes no lock file (read-only, or a volume without exclusive create): the document opened WITHOUT a lock. */
  readonly warning: 'DSF_LOCK_UNAVAILABLE' | null;
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

type Created = 'created' | 'exists' | 'unavailable';

const codeOf = (error: unknown): string | undefined => (error as NodeJS.ErrnoException).code;
const UNWRITABLE = new Set(['EACCES', 'EROFS', 'EPERM']);

/**
 * Create the lock file only if it does not exist: a hard link of a private temp (atomic and exclusive on POSIX and NTFS); on volumes that cannot
 * link (FAT / exFAT, some SMB shares: EPERM, ENOTSUP, EINVAL, EXDEV) an exclusive 'wx' create. 'unavailable': the folder takes no file at all.
 */
function createExclusive(lockPath: string, info: LockInfo): Created {
  const text = JSON.stringify(info);
  const staged = `${lockPath}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(staged, text, 'utf8');
  } catch (error) {
    if (UNWRITABLE.has(codeOf(error) ?? '')) return 'unavailable';
    throw error;
  }
  try {
    fs.linkSync(staged, lockPath);
    return 'created';
  } catch (error) {
    if (codeOf(error) === 'EEXIST') return 'exists';
    return createByOpen(lockPath, text);
  } finally {
    fs.rmSync(staged, { force: true });
  }
}

function createByOpen(lockPath: string, text: string): Created {
  try {
    const fd = fs.openSync(lockPath, 'wx');
    try {
      fs.writeSync(fd, text);
    } finally {
      fs.closeSync(fd);
    }
    return 'created';
  } catch (error) {
    if (codeOf(error) === 'EEXIST') return 'exists';
    if (UNWRITABLE.has(codeOf(error) ?? '')) return 'unavailable';
    throw error;
  }
}

/** A crash between the temp write and the link leaves `<lock>.<pid>.tmp`: remove those of pids that are gone. */
function removeDeadTemporaries(lockPath: string): void {
  const prefix = `${path.basename(lockPath)}.`;
  try {
    for (const name of fs.readdirSync(path.dirname(lockPath))) {
      const match = name.startsWith(prefix) ? /^(\d+)\.tmp$/.exec(name.slice(prefix.length)) : null;
      const pid = match?.[1] === undefined ? 0 : Number(match[1]);
      if (pid > 0 && pid !== process.pid && !processIsAlive(pid)) fs.rmSync(path.join(path.dirname(lockPath), name), { force: true });
    }
  } catch {
    // Missing or unreadable folder: nothing to clean.
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
  removeDeadTemporaries(lockPath);
  let tookOver: LockInfo | null = null;
  const ours = held.get(lockPath);
  const present = readLock(lockPath);
  if (ours !== undefined && present !== null && sameHolder(present, ours)) return handle(resolved, lockPath, ours, null);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const created = createExclusive(lockPath, mine);
    if (created === 'unavailable')
      return { documentPath: resolved, tookOver: null, warning: 'DSF_LOCK_UNAVAILABLE', release: () => undefined };
    if (created === 'created') {
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

const TAKEOVER_STALE_MS = 10_000;

/** Take the takeover mutex `<lock>.takeover` ('wx'); one older than TAKEOVER_STALE_MS belongs to a crashed taker and is removed once. */
function takeMutex(mutexPath: string): boolean {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fs.closeSync(fs.openSync(mutexPath, 'wx'));
      return true;
    } catch (error) {
      if (codeOf(error) !== 'EEXIST') return false;
      try {
        if (Date.now() - fs.statSync(mutexPath).mtimeMs < TAKEOVER_STALE_MS) return false;
        fs.rmSync(mutexPath, { force: true });
      } catch {
        return false;
      }
    }
  }
  return false;
}

/**
 * Remove the lock of a dead holder. Takeovers are serialized by the mutex, and the lock is checked to still be the stale one both before and
 * after it is renamed aside (a fresh lock of a live process is put back), so two takers never both end up holding the document.
 */
function removeStale(lockPath: string, stale: LockInfo): boolean {
  const mutexPath = `${lockPath}.takeover`;
  if (!takeMutex(mutexPath)) return false;
  try {
    const present = readLock(lockPath);
    if (present === null || !sameHolder(present, stale)) return false;
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
  } finally {
    fs.rmSync(mutexPath, { force: true });
  }
}

function handle(documentPath: string, lockPath: string, info: LockInfo, tookOver: LockInfo | null): DocumentLock {
  return {
    documentPath,
    tookOver,
    warning: null,
    release() {
      held.delete(lockPath);
      releaseFile(lockPath, info);
    },
  };
}
