/**
 * Hash-chained audit log of every host command (09 PLM FR-PLM-19, §5.8): JSONL segments `audit-NNNNNN.jsonl`, each entry carries the SHA-256 of
 * the previous entry and its own, so an edited, removed or reordered line breaks the chain. Rotation starts a new segment and NEVER deletes.
 * Environment: LLULL_AUDIT_DIR (default ~/.llull/audit; off in test runs unless set).
 * Honest limit: the chain is UNKEYED. It detects accidental damage and a partial rewrite; whoever can write the directory can rewrite the whole
 * chain consistently (and truncate its tail). Anchor it outside this machine (a signed head hash) to detect that.
 * Concurrency: appends take an exclusive lock file (`audit.lock`) so the CLI and the server can share the directory; a torn last line (crash during a write)
 * is closed by an `audit_chain_break` entry instead of failing the command.
 */

import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { jcsJson } from '@lib/jcs';
import { sha256Hex } from '@lib/sha256';
import { isTestRun } from '../env';

export interface AuditEvent {
  readonly ts: string;
  readonly source: string;
  readonly command: string;
  /** sha256 of the canonical JSON of the params. */
  readonly paramsSha256: string;
  readonly summary: string;
  readonly changed: boolean;
  readonly rejected: boolean;
  readonly affectedCount: number;
  readonly errorCode?: string;
}

interface AuditEntry extends AuditEvent {
  readonly seq: number;
  readonly prevSha256: string;
  readonly entrySha256: string;
}

/** The first entry's `prevSha256`. */
const GENESIS = '0'.repeat(64);
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const BREAK = 'audit_chain_break';
const LOCK_STALE_MS = 10_000;
const LOCK_WAIT_MS = 5_000;

export function auditDir(env: NodeJS.ProcessEnv = process.env): string | null {
  const configured = env['LLULL_AUDIT_DIR'];
  if (configured !== undefined && configured !== '') return path.resolve(configured);
  return isTestRun(env) ? null : path.join(homedir(), '.llull', 'audit');
}

const SEGMENT = /^audit-(\d{6})\.jsonl$/;
const segmentName = (n: number): string => `audit-${String(n).padStart(6, '0')}.jsonl`;

function segments(dir: string): string[] {
  return existsSync(dir)
    ? readdirSync(dir)
        .filter((name) => SEGMENT.test(name))
        .sort()
    : [];
}

const entryHash = (body: Omit<AuditEntry, 'entrySha256'>): string => sha256Hex(jcsJson(body));

/** Hash of the canonical params, so the same params hash equally whatever their key order. */
export const paramsHash = (params: unknown): string => sha256Hex(jcsJson(params ?? null));

export interface AuditLog {
  /** Append one event (synchronous, fsynced before returning) and return its entry. @failure never throws into the caller: see `appendSafely` */
  append(event: AuditEvent): AuditEntry;
}

const sleep = (ms: number): void => void Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** Run `body` holding the directory's exclusive lock file; a lock older than 10 s (a crashed process) is broken. */
function withLock<T>(dir: string, body: () => T): T {
  const lock = path.join(dir, 'audit.lock');
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      closeSync(openSync(lock, 'wx', 0o600));
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (existsSync(lock) && Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) rmSync(lock, { force: true });
      else if (Date.now() > deadline) throw new Error('audit log is locked by another process', { cause: error });
      else sleep(10);
    }
  }
  try {
    return body();
  } finally {
    rmSync(lock, { force: true });
  }
}

interface Tail {
  readonly entry: AuditEntry | null;
  /** The last line of the current segment is not a complete JSON entry. */
  readonly torn: boolean;
}

/** The last valid entry of the log and whether its file ends in a torn line. */
function readTail(dir: string): Tail {
  const files = segments(dir);
  for (let index = files.length - 1; index >= 0; index -= 1) {
    const text = readFileSync(path.join(dir, files[index] as string), 'utf8');
    const lines = text.split('\n').filter((line) => line !== '');
    for (let at = lines.length - 1; at >= 0; at -= 1) {
      try {
        return { entry: JSON.parse(lines[at] as string) as AuditEntry, torn: at !== lines.length - 1 || !text.endsWith('\n') };
      } catch {
        // a torn line: keep looking for the last valid entry
      }
    }
  }
  return { entry: null, torn: false };
}

/** Appender over `dir` (any number of processes); resumes the chain from the last entry on disk. @invariant a rotated segment is kept */
export function createAuditLog(dir: string, maxBytes: number = DEFAULT_MAX_BYTES): AuditLog {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  let cached: { readonly file: string; readonly size: number; readonly entry: AuditEntry } | null = null;
  const write = (
    event: AuditEvent | (Omit<AuditEvent, never> & { command: string }),
    previous: AuditEntry | null,
    prefix: string,
  ): AuditEntry => {
    const body = { ...event, seq: (previous?.seq ?? 0) + 1, prevSha256: previous?.entrySha256 ?? GENESIS };
    const entry: AuditEntry = { ...body, entrySha256: entryHash(body) };
    const files = segments(dir);
    const current = files.at(-1);
    const number = current === undefined ? 1 : Number(SEGMENT.exec(current)?.[1]);
    const rotate = current !== undefined && statSync(path.join(dir, current)).size >= maxBytes;
    const file = path.join(dir, segmentName(rotate ? number + 1 : number));
    const descriptor = openSync(file, 'a', 0o600);
    try {
      writeSync(descriptor, `${prefix}${JSON.stringify(entry)}\n`);
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    cached = { file, size: statSync(file).size, entry };
    return entry;
  };
  return {
    append: (event) =>
      withLock(dir, () => {
        const files = segments(dir);
        const last = files.at(-1);
        const fresh =
          cached !== null && last !== undefined && path.join(dir, last) === cached.file && statSync(cached.file).size === cached.size;
        let previous = fresh && cached !== null ? cached.entry : null;
        if (!fresh) {
          const tail = readTail(dir);
          previous = tail.entry;
          if (tail.torn && previous !== null)
            previous = write(
              {
                ts: event.ts,
                source: 'audit',
                command: BREAK,
                paramsSha256: paramsHash(null),
                summary: 'a torn last line was closed',
                changed: false,
                rejected: false,
                affectedCount: 0,
              },
              previous,
              '\n',
            );
        }
        return write(event, previous, '');
      }),
  };
}

/** Append without ever failing the command being audited: a failure to write the audit is reported on stderr and returns null. */
export function appendSafely(log: AuditLog, event: AuditEvent): AuditEntry | null {
  try {
    return log.append(event);
  } catch (error) {
    console.warn(`[llull] audit log not written: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

interface ChainVerdict {
  readonly ok: boolean;
  readonly entries: number;
  /** Torn lines closed by an `audit_chain_break` entry (crash repairs, reported, not failures). */
  readonly repairs: number;
  readonly brokenAt?: { readonly file: string; readonly line: number; readonly reason: string };
}

/** Recompute the chain over every segment in order. @failure the first bad entry is reported (code PLM_AUDIT_CHAIN_BROKEN at the CLI) */
export function verifyAuditChain(dir: string): ChainVerdict {
  let previous = GENESIS;
  let expectedSeq = 1;
  let count = 0;
  let repairs = 0;
  let tornAt: { file: string; line: number } | null = null;
  for (const file of segments(dir)) {
    const lines = readFileSync(path.join(dir, file), 'utf8').split('\n');
    for (const [index, text] of lines.entries()) {
      if (text === '') continue;
      const broken = (reason: string): ChainVerdict => ({
        ok: false,
        entries: count,
        repairs,
        brokenAt: { file, line: index + 1, reason },
      });
      let entry: AuditEntry;
      try {
        entry = JSON.parse(text) as AuditEntry;
      } catch {
        if (tornAt !== null) return broken('not valid JSON');
        tornAt = { file, line: index + 1 };
        continue;
      }
      if (tornAt !== null) {
        if (entry.command !== BREAK) return { ok: false, entries: count, repairs, brokenAt: { ...tornAt, reason: 'not valid JSON' } };
        tornAt = null;
        repairs += 1;
      }
      const { entrySha256, ...body } = entry;
      if (entry.prevSha256 !== previous) return broken('prevSha256 does not match the previous entry');
      if (entry.seq !== expectedSeq) return broken(`seq ${entry.seq} where ${expectedSeq} was expected`);
      if (entryHash(body) !== entrySha256) return broken('entrySha256 does not match the entry content');
      previous = entrySha256;
      expectedSeq += 1;
      count += 1;
    }
  }
  return { ok: true, entries: count, repairs };
}
