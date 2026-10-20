/**
 * Exclusive item locks of the local vault (09 PLM M3, §6.2): `locks/<item>.lock` is created with O_EXCL (`wx`), so two sessions on one folder (or one
 * share) never both hold an item. A lock has a lease (8 h default). A stale lock (lease expired and, on this host, its process gone) can be broken, and
 * the break is the caller's to audit.
 */

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs';
import path from 'node:path';
import { isRecord } from '@lib/isRecord';
import { writeFileAtomic } from '../../writeFileAtomic';

const DEFAULT_LEASE_MS = 8 * 60 * 60 * 1000;

/** Who holds an item. `session` separates two launches of the same user on the same host (the desktop app picks one per launch). */
export interface LockHolder {
  readonly userId: string;
  readonly name: string;
  readonly host: string;
  readonly session: string;
  readonly pid: number;
}

export interface LockRecord {
  readonly holder: LockHolder;
  readonly acquiredAt: string;
  readonly leaseUntil: string;
}

export const sameHolder = (a: LockHolder, b: LockHolder): boolean => a.userId === b.userId && a.host === b.host && a.session === b.session;

const lockFile = (root: string, stem: string): string => path.join(root, 'locks', `${stem}.lock`);

export function readLock(root: string, stem: string): LockRecord | null {
  const file = lockFile(root, stem);
  if (!existsSync(file)) return null;
  try {
    const raw: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (isRecord(raw) && isRecord(raw['holder']) && typeof raw['leaseUntil'] === 'string' && typeof raw['acquiredAt'] === 'string')
      return raw as unknown as LockRecord;
  } catch {
    // an unreadable lock file reads as a long-expired lock of an unknown holder: it blocks, and anyone may break it (audited)
  }
  return {
    holder: { userId: '?', name: 'unreadable lock', host: '?', session: '?', pid: 0 },
    acquiredAt: '',
    leaseUntil: '1970-01-01T00:00:00.000Z',
  };
}

export type Acquire =
  | { readonly ok: true; readonly lock: LockRecord; readonly renewed: boolean }
  | { readonly ok: false; readonly held: LockRecord };

/** Take the lock of `stem`: O_EXCL create; the same holder asking again renews its lease. @failure held by another -> { ok: false, held } */
export function acquireLock(root: string, stem: string, holder: LockHolder, now: Date, leaseMs: number = DEFAULT_LEASE_MS): Acquire {
  mkdirSync(path.join(root, 'locks'), { recursive: true });
  const lock: LockRecord = { holder, acquiredAt: now.toISOString(), leaseUntil: new Date(now.getTime() + leaseMs).toISOString() };
  try {
    const descriptor = openSync(lockFile(root, stem), 'wx', 0o644);
    try {
      writeSync(descriptor, `${JSON.stringify(lock)}\n`);
    } finally {
      closeSync(descriptor);
    }
    return { ok: true, lock, renewed: false };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const held = readLock(root, stem);
  if (held === null) return acquireLock(root, stem, holder, now, leaseMs);
  if (!sameHolder(held.holder, holder)) return { ok: false, held };
  const renewed: LockRecord = { ...held, holder, leaseUntil: lock.leaseUntil };
  writeFileAtomic(lockFile(root, stem), `${JSON.stringify(renewed)}\n`);
  return { ok: true, lock: renewed, renewed: true };
}

/** Delete the lock when `holder` holds it; false when it is free or another holder's. */
export function releaseLock(root: string, stem: string, holder: LockHolder): boolean {
  const held = readLock(root, stem);
  if (held === null || !sameHolder(held.holder, holder)) return false;
  rmSync(lockFile(root, stem), { force: true });
  return true;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** A lock is stale when its lease has expired and, when it was taken on this host, its process is gone (another host's process cannot be checked). */
export const isStale = (lock: LockRecord, now: Date, thisHost: string): boolean =>
  new Date(lock.leaseUntil).getTime() < now.getTime() && (lock.holder.host !== thisHost || !processAlive(lock.holder.pid));

/** Remove a stale lock (or the lock `by` holds itself). @returns the lock that was broken, or null when it is free or neither stale nor `by`'s own */
export function breakLock(root: string, stem: string, by: LockHolder, now: Date): LockRecord | null {
  const held = readLock(root, stem);
  if (held === null) return null;
  if (!sameHolder(held.holder, by) && !isStale(held, now, by.host)) return null;
  rmSync(lockFile(root, stem), { force: true });
  return held;
}
