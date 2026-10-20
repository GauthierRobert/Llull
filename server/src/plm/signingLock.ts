/**
 * Brute-force limiter of the signing endpoint, persisted so a process restart does not reset it: the first MAX_FREE wrong passphrases of a key are free,
 * every further one doubles the lock (1 min, 2 min, 4 min … capped at one day). A correct passphrase clears the counter.
 * Residual risk: whoever can write the trust directory can reset it (they could equally rewrite the key files; docs 09 §13.5).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { isRecord } from '@lib/isRecord';
import { trustDirectory } from './hostConfig';

const MAX_FREE = 4;
const BASE_LOCK_MS = 60_000;
const MAX_LOCK_MS = 24 * 3_600_000;

interface Counter {
  readonly failures: number;
  readonly lockedUntil: number;
}

const fileOf = (): string => path.join(trustDirectory(), 'signing-failures.json');

function readAll(): Record<string, Counter> {
  try {
    const parsed: unknown = existsSync(fileOf()) ? JSON.parse(readFileSync(fileOf(), 'utf8')) : {};
    if (!isRecord(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).flatMap(([key, value]) =>
        isRecord(value) && typeof value['failures'] === 'number' && typeof value['lockedUntil'] === 'number'
          ? [[key, { failures: value['failures'], lockedUntil: value['lockedUntil'] }]]
          : [],
      ),
    );
  } catch {
    return {};
  }
}

function writeAll(all: Record<string, Counter>): void {
  mkdirSync(trustDirectory(), { recursive: true, mode: 0o700 });
  writeFileSync(fileOf(), `${JSON.stringify(all)}\n`, { mode: 0o600 });
}

/** Milliseconds `keyId` stays locked (0 = free to try). */
export const lockedForMs = (keyId: string, now: number): number => Math.max(0, (readAll()[keyId]?.lockedUntil ?? 0) - now);

/** Count a wrong passphrase; returns the lock now in force in ms. */
export function recordFailure(keyId: string, now: number): number {
  const all = readAll();
  const failures = (all[keyId]?.failures ?? 0) + 1;
  const lock = failures <= MAX_FREE ? 0 : Math.min(MAX_LOCK_MS, BASE_LOCK_MS * 2 ** (failures - MAX_FREE - 1));
  writeAll({ ...all, [keyId]: { failures, lockedUntil: now + lock } });
  return lock;
}

export function clearFailures(keyId: string): void {
  const { [keyId]: _cleared, ...rest } = readAll();
  if (_cleared !== undefined) writeAll(rest);
}
