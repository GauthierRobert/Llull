/**
 * The local vault (09 PLM M3, FR-PLM-22, §6.2): a folder on this machine (or a share) holding content-addressed objects, per-item refs, exclusive locks
 * and a hash-chained audit log. One machine, no network, no server: hosts (CLI, desktop menu) call these functions; the document itself changes only through
 * commands (`checkpoint_iteration`, `externalize_snapshots`). Layout:
 *   vault.json                         { format: 'llull-vault', version: 1, hash: 'sha256' }
 *   objects/<2>/<62>                   immutable blobs named by SHA-256 (snapshots, head documents)
 *   items/<item>/refs.json             frozen revisions { state, contentHash, snapshot } and the head document with its history
 *   items/<item>/<REV>/manifest.json   human-browsable copy of the release manifest of a frozen revision
 *   locks/<item>.lock                  O_EXCL lock with lease
 *   audit/audit-NNNNNN.jsonl           hash chain of vault events (check-out, check-in, renew, break)
 * Honest limit: same as the audit chain: whoever can write the folder can rewrite it; the vault protects against accidents and concurrent sessions,
 * not against a hostile user of the machine. Released history is protected by the content hashes the documents carry and by `checkIn` refusing a
 * document whose frozen revision differs from the vault's record.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { hostname, userInfo } from 'node:os';
import path from 'node:path';
import { execute } from '@core/commands/registry';
import { serializeDocument } from '@core/commands/persistence/serialization';
import type { ExecutionContext } from '@core/commands/types';
import type { CadDocument } from '@core/model/types';
import { isRecord } from '@lib/isRecord';
import { jcsJson } from '@lib/jcs';
import { writeFileAtomic } from '../../writeFileAtomic';
import { serverContext } from '../../fea/context';
import { type AuditLog, appendSafely, createAuditLog, paramsHash } from '../auditChain';
import { isoSeconds } from '../hostRun';
import { type LockHolder, type LockRecord, acquireLock, breakLock, isStale, readLock, releaseLock, sameHolder } from './locks';
import { type ObjectStore, createObjectStore } from './objectStore';

export type VaultCode =
  | 'PLM_VAULT_NOT_FOUND'
  | 'PLM_VAULT_LOCKED'
  | 'PLM_VAULT_NOT_HELD'
  | 'PLM_VAULT_ITEM_UNKNOWN'
  | 'PLM_HISTORY_IMMUTABLE'
  | 'PLM_VAULT_REFUSED';

/** A refusal of a vault operation: a stable code, the message and, for a lock, who holds it. */
export class VaultError extends Error {
  constructor(
    readonly code: VaultCode,
    message: string,
    readonly holder?: LockHolder,
  ) {
    super(message);
  }
}

interface FrozenRef {
  readonly state: string;
  readonly contentHash: string;
  /** SHA-256 of the snapshot object (equals contentHash). */
  readonly snapshot: string;
}

export interface Refs {
  readonly item: string;
  readonly revisions: Readonly<Record<string, FrozenRef>>;
  /** SHA-256 of the latest checked-in document, null before the first check-in. */
  readonly head: string | null;
  readonly history: readonly {
    readonly sha256: string;
    readonly at: string;
    readonly by: string;
    readonly revision: string;
    readonly iteration: number;
  }[];
}

export interface Vault {
  readonly dir: string;
  readonly objects: ObjectStore;
  readonly audit: (command: string, summary: string, details: unknown, rejected?: boolean) => void;
}

/** The folder name of an item: part numbers allow `/` and other characters a file name cannot hold, so every such character is %-encoded. */
const itemStem = (partNumber: string): string =>
  partNumber.replace(/[^A-Za-z0-9._-]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`);

const refsFile = (vault: Vault, stem: string): string => path.join(vault.dir, 'items', stem, 'refs.json');

/** The holder of locks for this process: `LLULL_USER` (else the OS user), this host, a stable session (`cli`, or the desktop's per-launch id). */
export function currentHolder(env: NodeJS.ProcessEnv = process.env, session = 'cli'): LockHolder {
  const configured = env['LLULL_USER'];
  let user = 'unknown';
  try {
    user = configured !== undefined && configured !== '' ? configured : userInfo().username;
  } catch {
    // keep 'unknown'
  }
  return { userId: user, name: user, host: hostname(), session, pid: process.pid };
}

function open(dir: string): Vault {
  const root = path.resolve(dir);
  const log: AuditLog = createAuditLog(path.join(root, 'audit'));
  return {
    dir: root,
    objects: createObjectStore(root),
    audit: (command, summary, details, rejected = false) =>
      void appendSafely(log, {
        ts: new Date().toISOString(),
        source: 'vault',
        command,
        paramsSha256: paramsHash(details),
        summary: summary.slice(0, 500),
        changed: !rejected,
        rejected,
        affectedCount: 0,
      }),
  };
}

/** Create the vault folder (idempotent). @failure a folder holding another format -> PLM_VAULT_NOT_FOUND */
export function initVault(dir: string): Vault {
  const marker = path.join(path.resolve(dir), 'vault.json');
  if (existsSync(marker)) return openVault(dir);
  mkdirSync(path.resolve(dir), { recursive: true });
  writeFileAtomic(marker, `${JSON.stringify({ format: 'llull-vault', version: 1, hash: 'sha256' }, null, 2)}\n`);
  return open(dir);
}

/** Open an existing vault. @failure no vault.json / another format or version -> PLM_VAULT_NOT_FOUND */
export function openVault(dir: string): Vault {
  const marker = path.join(path.resolve(dir), 'vault.json');
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(readFileSync(marker, 'utf8'));
  } catch {
    // reported below
  }
  if (!isRecord(parsed) || parsed['format'] !== 'llull-vault' || parsed['version'] !== 1 || parsed['hash'] !== 'sha256')
    throw new VaultError('PLM_VAULT_NOT_FOUND', `${dir} is not an llull vault (no valid vault.json); create one with: llull vault init`);
  return open(dir);
}

export function readRefs(vault: Vault, partNumber: string): Refs | null {
  const file = refsFile(vault, itemStem(partNumber));
  if (!existsSync(file)) return null;
  const raw: unknown = JSON.parse(readFileSync(file, 'utf8'));
  return isRecord(raw) ? (raw as unknown as Refs) : null;
}

const lockedError = (partNumber: string, held: LockRecord): VaultError =>
  new VaultError(
    'PLM_VAULT_LOCKED',
    `${partNumber} is checked out by ${held.holder.name} (${held.holder.userId}@${held.holder.host}) until ${held.leaseUntil}; wait, or a stale lock can be broken (llull vault break-lock)`,
    held.holder,
  );

/**
 * Check out `partNumber`: take the exclusive lock, return the head document (null when the item was never checked in: the caller starts a new document).
 * @failure held by another session -> PLM_VAULT_LOCKED naming the holder
 */
export function checkOut(vault: Vault, partNumber: string, holder: LockHolder, now: Date): { document: string | null; lock: LockRecord } {
  const taken = acquireLock(vault.dir, itemStem(partNumber), holder, now);
  if (!taken.ok) {
    vault.audit(
      'vault_checkout',
      `${partNumber} check-out refused: held by ${taken.held.holder.userId}`,
      { partNumber, by: holder.userId },
      true,
    );
    throw lockedError(partNumber, taken.held);
  }
  const head = readRefs(vault, partNumber)?.head ?? null;
  vault.audit('vault_checkout', `${partNumber} checked out by ${holder.userId}${taken.renewed ? ' (lease renewed)' : ''}`, {
    partNumber,
    by: holder.userId,
  });
  return { document: head === null ? null : vault.objects.get(head), lock: taken.lock };
}

/** Extend the lease of the lock `holder` holds. @failure not held by `holder` -> PLM_VAULT_NOT_HELD */
export function renew(vault: Vault, partNumber: string, holder: LockHolder, now: Date): LockRecord {
  const held = readLock(vault.dir, itemStem(partNumber));
  if (held === null || !sameHolder(held.holder, holder))
    throw new VaultError('PLM_VAULT_NOT_HELD', `${partNumber} is not checked out by you`);
  const renewed = acquireLock(vault.dir, itemStem(partNumber), holder, now);
  if (!renewed.ok) throw lockedError(partNumber, renewed.held);
  return renewed.lock;
}

/** Break a stale lock (lease expired and its process gone) or your own: audited. @failure free / live lock of another -> PLM_VAULT_LOCKED or PLM_VAULT_NOT_HELD */
export function breakItemLock(vault: Vault, partNumber: string, by: LockHolder, now: Date): LockRecord {
  const held = readLock(vault.dir, itemStem(partNumber));
  if (held === null) throw new VaultError('PLM_VAULT_NOT_HELD', `${partNumber} is not locked`);
  const broken = breakLock(vault.dir, itemStem(partNumber), by, now);
  if (broken === null) {
    vault.audit(
      'vault_break_lock',
      `break of ${partNumber} refused: the lock of ${held.holder.userId} is live`,
      { partNumber, by: by.userId },
      true,
    );
    throw lockedError(partNumber, held);
  }
  vault.audit('vault_break_lock', `${partNumber} lock of ${broken.holder.userId}@${broken.holder.host} broken by ${by.userId}`, {
    partNumber,
    by: by.userId,
    was: broken,
  });
  return broken;
}

/** The context a vault operation runs commands in: the server defaults plus this vault's objects as `ctx.objects`. */
const contextOf = (vault: Vault): ExecutionContext => ({ ...serverContext(), objects: vault.objects });

export interface CheckInResult {
  readonly document: CadDocument;
  readonly head: string;
  readonly revision: string;
  readonly iteration: number;
  readonly notes: readonly string[];
}

const FROZEN = new Set(['released', 'superseded', 'obsolete']);

/**
 * Check in `doc` (the lock holder's working document): checkpoint the iteration when the revision is in_work, store every frozen snapshot as an object and
 * externalize it, store the head document, update the refs, write the manifest copies of newly frozen revisions and free the lock.
 * @invariant a frozen revision already recorded in the vault must carry the same content hash in `doc` (PLM_HISTORY_IMMUTABLE otherwise); nothing is written then
 * @failure not a managed item / another item than the lock's -> PLM_VAULT_REFUSED; lock not held -> PLM_VAULT_NOT_HELD
 */
export function checkIn(vault: Vault, doc: CadDocument, holder: LockHolder, now: Date): CheckInResult {
  const plm = doc.plm;
  if (plm === undefined) throw new VaultError('PLM_VAULT_REFUSED', 'only a managed item (set_item_identity) can be checked in');
  const partNumber = plm.item.partNumber;
  const stem = itemStem(partNumber);
  const held = readLock(vault.dir, stem);
  if (held === null || !sameHolder(held.holder, holder)) {
    if (held !== null) throw lockedError(partNumber, held);
    throw new VaultError('PLM_VAULT_NOT_HELD', `${partNumber} is not checked out by you; check it out first`);
  }
  const refs = readRefs(vault, partNumber);
  for (const [label, frozen] of Object.entries(refs?.revisions ?? {})) {
    if (plm.item.revisions[label]?.contentHash !== frozen.contentHash)
      throw new VaultError(
        'PLM_HISTORY_IMMUTABLE',
        `${partNumber} rev ${label} differs from the vault record (released history cannot change); not checked in`,
      );
  }
  const ctx = contextOf(vault);
  const at = isoSeconds(now);
  const notes: string[] = [];
  let next = doc;
  if (plm.item.revisions[plm.item.currentRevision]?.state === 'in_work') {
    const checkpoint = execute(next, 'checkpoint_iteration', { at, by: holder.userId, comment: 'check-in' }, ctx);
    if (checkpoint.rejected !== true) next = checkpoint.document;
    notes.push(checkpoint.summary);
  }
  for (const revision of Object.values(next.plm?.item.revisions ?? {})) {
    if (revision.snapshot?.kind === 'inline') vault.objects.put(revision.snapshot.canonicalJson);
  }
  const externalized = execute(next, 'externalize_snapshots', {}, ctx);
  if (externalized.rejected === true) throw new VaultError('PLM_VAULT_REFUSED', externalized.summary);
  next = externalized.document;
  const head = vault.objects.put(serializeDocument(next));
  const item = (next.plm as NonNullable<CadDocument['plm']>).item;
  const current = item.revisions[item.currentRevision];
  const frozenRefs: Record<string, FrozenRef> = { ...refs?.revisions };
  for (const label of item.revisionOrder) {
    const revision = item.revisions[label];
    if (revision === undefined || !FROZEN.has(revision.state) || revision.contentHash === undefined) continue;
    frozenRefs[label] = { state: revision.state, contentHash: revision.contentHash, snapshot: revision.contentHash };
    if (refs?.revisions[label] === undefined) writeManifestCopy(vault, next, stem, label);
  }
  const iteration = current?.iterations.length ?? 0;
  const updated: Refs = {
    item: partNumber,
    revisions: frozenRefs,
    head,
    history: [...(refs?.history ?? []), { sha256: head, at, by: holder.userId, revision: item.currentRevision, iteration }],
  };
  mkdirSync(path.dirname(refsFile(vault, stem)), { recursive: true });
  writeFileAtomic(refsFile(vault, stem), `${JSON.stringify(updated, null, 2)}\n`);
  releaseLock(vault.dir, stem, holder);
  vault.audit(
    'vault_checkin',
    `${partNumber} rev ${item.currentRevision}.${iteration} checked in by ${holder.userId}: head ${head.slice(0, 12)}…`,
    { partNumber, head, by: holder.userId },
  );
  return { document: next, head, revision: item.currentRevision, iteration, notes };
}

/** The human-browsable copy of the release manifest of a newly frozen revision (`items/<item>/<REV>/manifest.json`). */
function writeManifestCopy(vault: Vault, doc: CadDocument, stem: string, label: string): void {
  const manifest = execute(doc, 'release_manifest', { revision: label }, contextOf(vault));
  const body = (manifest.data as { body?: unknown } | undefined)?.body;
  if (body === undefined) return;
  const signatures = doc.plm?.item.revisions[label]?.signatures ?? [];
  const directory = path.join(vault.dir, 'items', stem, label);
  mkdirSync(directory, { recursive: true });
  writeFileAtomic(path.join(directory, 'manifest.json'), `${jcsJson({ body, signatures })}\n`);
}

export interface ItemStatus {
  readonly partNumber: string;
  readonly refs: Refs | null;
  readonly lock: (LockRecord & { readonly stale: boolean }) | null;
}

/** Refs and lock of an item (no mutation); `now` decides staleness. */
export function itemStatus(vault: Vault, partNumber: string, now: Date, host: string): ItemStatus {
  const lock = readLock(vault.dir, itemStem(partNumber));
  return { partNumber, refs: readRefs(vault, partNumber), lock: lock === null ? null : { ...lock, stale: isStale(lock, now, host) } };
}

/** Every item that has refs in the vault, sorted. */
export function listItems(vault: Vault): string[] {
  const root = path.join(vault.dir, 'items');
  if (!existsSync(root)) return [];
  const stems = readdirSync(root);
  return stems
    .flatMap((stem) => {
      const file = path.join(root, stem, 'refs.json');
      if (!existsSync(file)) return [];
      const raw: unknown = JSON.parse(readFileSync(file, 'utf8'));
      return isRecord(raw) && typeof raw['item'] === 'string' ? [raw['item']] : [];
    })
    .sort();
}

/** Re-hash every object and check each ref points at a present object. */
export function verifyVault(vault: Vault): { readonly ok: boolean; readonly objects: number; readonly findings: readonly string[] } {
  const { checked, damaged } = vault.objects.verify();
  const findings = damaged.map((sha) => `object ${sha} is damaged (its content no longer hashes to its name)`);
  for (const item of listItems(vault)) {
    const refs = readRefs(vault, item);
    for (const [label, frozen] of Object.entries(refs?.revisions ?? {}))
      if (!vault.objects.has(frozen.snapshot))
        findings.push(`${item} rev ${label}: snapshot object ${frozen.snapshot} is missing or damaged`);
    if (refs?.head != null && !vault.objects.has(refs.head)) findings.push(`${item}: head object ${refs.head} is missing or damaged`);
  }
  return { ok: findings.length === 0, objects: checked, findings };
}
