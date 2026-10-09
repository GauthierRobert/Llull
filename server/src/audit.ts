/**
 * @layer server
 * Per-user audit trail: one JSONL line per applied command, written at the transport layer
 * (`commandBus` callers), never inside commands. Size-based rotation: `audit.jsonl` ->
 * `audit.jsonl.1` ... `.N`.
 *
 * Env: LLULL_AUDIT_FILE (default `audit.jsonl` next to the autosave; under tests only when set),
 * LLULL_AUDIT_MAX_BYTES (10 MiB), LLULL_AUDIT_KEEP (rotated files kept, 5).
 */

import fs from 'fs';
import path from 'path';
import { errorMessage } from '@lib/errorMessage';
import type { Response } from 'express';
import { requestUser, sha256Hex } from './users';

export type AuditSource = 'rest' | 'mcp';

/** Who is acting; `userId` is `anonymous` when no named-user auth is in play. */
export interface Actor {
  readonly userId: string;
  readonly userName: string;
  readonly source: AuditSource;
  /** True for an authenticated named user (live events then carry the id). */
  readonly named: boolean;
}

export interface AuditEntry {
  readonly ts: string;
  readonly userId: string;
  readonly userName: string;
  readonly source: AuditSource;
  readonly command: string;
  readonly paramsSha256: string;
  readonly summary: string;
  readonly affectedCount: number;
  readonly epoch: string;
  readonly seq: number;
}

export const ANONYMOUS_ACTOR = (source: AuditSource): Actor => ({
  userId: 'anonymous',
  userName: 'anonymous',
  source,
  named: false,
});

/** The acting user of an authenticated request (anonymous outside named-user mode). */
export function actorOf(res: Response, source: AuditSource): Actor {
  const user = requestUser(res);
  return user === undefined
    ? ANONYMOUS_ACTOR(source)
    : { userId: user.id, userName: user.name, source, named: true };
}

function posInt(value: string | undefined, fallback: number): number {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Resolved audit file, or null when auditing is off (tests without LLULL_AUDIT_FILE). */
export function auditFilePath(defaultDirectory: string): string | null {
  const configured = process.env['LLULL_AUDIT_FILE']?.trim();
  if (configured !== undefined && configured !== '') return configured;
  if (process.env['VITEST'] !== undefined || process.env['TEST'] === 'true') return null;
  return path.join(defaultDirectory, 'audit.jsonl');
}

let defaultDirectory = path.resolve(__dirname, '..');

/** Directory holding the default audit file (set by liveDocument to the autosave directory). */
export function setAuditDefaultDirectory(directory: string): void {
  defaultDirectory = directory;
}

export function hashParams(params: unknown): string {
  try {
    return sha256Hex(JSON.stringify(params ?? null));
  } catch {
    return '';
  }
}

function rotate(file: string, keep: number): void {
  fs.rmSync(`${file}.${keep}`, { force: true });
  for (let index = keep - 1; index >= 1; index -= 1) {
    if (fs.existsSync(`${file}.${index}`))
      fs.renameSync(`${file}.${index}`, `${file}.${index + 1}`);
  }
  fs.renameSync(file, `${file}.1`);
}

/** Append one line (rotating first when it would exceed the size cap). Never throws. */
export function appendAudit(entry: AuditEntry): void {
  const file = auditFilePath(defaultDirectory);
  if (file === null) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const line = `${JSON.stringify(entry)}\n`;
    const size = fs.existsSync(file) ? fs.statSync(file).size : 0;
    if (
      size > 0 &&
      size + Buffer.byteLength(line) >
        posInt(process.env['LLULL_AUDIT_MAX_BYTES'], 10 * 1024 * 1024)
    ) {
      rotate(file, posInt(process.env['LLULL_AUDIT_KEEP'], 5));
    }
    fs.appendFileSync(file, line, { encoding: 'utf8', mode: 0o600 });
  } catch (err) {
    console.warn(`[audit] write failed: ${errorMessage(err)}`);
  }
}

interface AuditQuery {
  readonly since?: string;
  readonly user?: string;
  readonly limit: number;
}

/** Newest-last entries matching the query, across rotated files (oldest file first). */
export function readAudit(query: AuditQuery): AuditEntry[] {
  const file = auditFilePath(defaultDirectory);
  if (file === null) return [];
  const sinceMs = query.since === undefined ? -Infinity : Date.parse(query.since);
  const matches: AuditEntry[] = [];
  const keep = posInt(process.env['LLULL_AUDIT_KEEP'], 5);
  const files = [file, ...Array.from({ length: keep }, (_, i) => `${file}.${i + 1}`)].reverse();
  for (const candidate of files) {
    let text: string;
    try {
      text = fs.readFileSync(candidate, 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      if (line === '') continue;
      try {
        const entry = JSON.parse(line) as AuditEntry;
        if (Date.parse(entry.ts) < sinceMs) continue;
        if (query.user !== undefined && entry.userId !== query.user) continue;
        matches.push(entry);
      } catch {
        // skip a torn line
      }
    }
  }
  return matches.slice(-query.limit);
}
