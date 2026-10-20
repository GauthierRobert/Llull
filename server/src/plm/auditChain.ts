/**
 * Hash-chained audit log of every host command (09 PLM FR-PLM-19, §5.8): JSONL segments `audit-NNNNNN.jsonl`, each entry carries the SHA-256 of
 * the previous entry and its own, so an edited, removed or reordered line breaks the chain. Rotation starts a new segment and NEVER deletes
 * (the chain continues across files). Environment: LLULL_AUDIT_DIR (default ~/.llull/audit; off in test runs unless set).
 */

import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, statSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { canonicalJson } from '@lib/canonicalJson';
import { sha256Hex } from '@lib/sha256';
import { isTestRun } from '../env';

export interface AuditEvent {
  readonly ts: string;
  readonly caller: 'human' | 'agent' | 'unknown';
  readonly userId?: string;
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

const entryHash = (body: Omit<AuditEntry, 'entrySha256'>): string => sha256Hex(canonicalJson(body));

/** Hash of the canonical params, so the same params hash equally whatever their key order. */
export const paramsHash = (params: unknown): string => sha256Hex(canonicalJson(params ?? null));

export interface AuditLog {
  /** Append one event (synchronous, fsynced before returning) and return its entry. */
  append(event: AuditEvent): AuditEntry;
}

function lastEntry(dir: string): AuditEntry | null {
  const files = segments(dir);
  for (let index = files.length - 1; index >= 0; index -= 1) {
    const lines = readFileSync(path.join(dir, files[index] as string), 'utf8')
      .split('\n')
      .filter((line) => line !== '');
    const last = lines.at(-1);
    if (last !== undefined) return JSON.parse(last) as AuditEntry;
  }
  return null;
}

/** Appender over `dir`; resumes the chain from the last entry on disk. @invariant a rotated segment is kept */
export function createAuditLog(dir: string, maxBytes: number = DEFAULT_MAX_BYTES): AuditLog {
  mkdirSync(dir, { recursive: true });
  return {
    append(event) {
      const previous = lastEntry(dir);
      const body = { ...event, seq: (previous?.seq ?? 0) + 1, prevSha256: previous?.entrySha256 ?? GENESIS };
      const entry: AuditEntry = { ...body, entrySha256: entryHash(body) };
      const files = segments(dir);
      const current = files.at(-1);
      const number = current === undefined ? 1 : Number(SEGMENT.exec(current)?.[1]);
      const rotate = current !== undefined && statSync(path.join(dir, current)).size >= maxBytes;
      const file = path.join(dir, segmentName(rotate ? number + 1 : number));
      const descriptor = openSync(file, 'a', 0o600);
      try {
        writeSync(descriptor, `${JSON.stringify(entry)}\n`);
        fsyncSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
      return entry;
    },
  };
}

export interface ChainVerdict {
  readonly ok: boolean;
  readonly entries: number;
  readonly brokenAt?: { readonly file: string; readonly line: number; readonly reason: string };
}

/** Recompute the chain over every segment in order. @failure the first bad entry is reported (code PLM_AUDIT_CHAIN_BROKEN at the CLI) */
export function verifyAuditChain(dir: string): ChainVerdict {
  let previous = GENESIS;
  let expectedSeq = 1;
  let count = 0;
  for (const file of segments(dir)) {
    const lines = readFileSync(path.join(dir, file), 'utf8').split('\n');
    for (const [index, text] of lines.entries()) {
      if (text === '') continue;
      const broken = (reason: string): ChainVerdict => ({ ok: false, entries: count, brokenAt: { file, line: index + 1, reason } });
      let entry: AuditEntry;
      try {
        entry = JSON.parse(text) as AuditEntry;
      } catch {
        return broken('not valid JSON');
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
  return { ok: true, entries: count };
}
