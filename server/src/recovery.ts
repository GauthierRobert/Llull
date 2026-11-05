/**
 * Per-document recovery slots (A-08, FR-DSF-05..07): every open document has its own slot in the recovery directory, so opening B never
 * overwrites A's recovery. A slot is `<id>.json` (the serialized document, written by the autosaver with the fsync + rename discipline of
 * `writeFileAtomic`) and `<id>.meta.json` (path, last change time, change count). `active.json` names the slot of the running backend so a
 * supervised restart resumes it. Pure file-system state: no document logic (architecture L6).
 */

import fs from 'fs';
import path from 'path';
import { createHash, randomBytes } from 'crypto';
import { isRecord } from '@lib/isRecord';
import { readJsonFile } from './readJsonFile';
import { writeFileAtomic } from './writeFileAtomic';

/** The file the slot's document was opened from or last saved to: what a restore must still find on disk to take the file's path back. */
export interface SlotBase {
  readonly sha256: string;
  readonly size: number;
}

export interface RecoverySlotMeta {
  readonly id: string;
  /** Absolute path of the document the slot belongs to; null = an untitled document. */
  readonly path: string | null;
  /** `offline`: edits made while the backend was unreachable, kept next to the backend's own state (FR-DSF-23). */
  readonly kind: 'document' | 'offline';
  readonly label: string;
  /** ISO time of the last change that reached the slot. */
  readonly changedAt: string;
  readonly changeCount: number;
  /** SHA-256 and size of the document file as opened / last saved (null: untitled, or unknown). */
  readonly baseSha256: string | null;
  readonly baseSize: number | null;
}

export const metaBase = (meta: RecoverySlotMeta): SlotBase | null =>
  meta.baseSha256 === null || meta.baseSize === null ? null : { sha256: meta.baseSha256, size: meta.baseSize };

export const baseFields = (base: SlotBase | null): Pick<RecoverySlotMeta, 'baseSha256' | 'baseSize'> => ({
  baseSha256: base?.sha256 ?? null,
  baseSize: base?.size ?? null,
});

const META_SUFFIX = '.meta.json';
const SLOT_ID = /^[A-Za-z0-9._-]{1,80}$/;

export const isSlotId = (id: string): boolean => SLOT_ID.test(id) && !id.includes('..');

/** The stable slot id of a document path (case-folded on Windows, where paths are case-insensitive). */
export function slotIdForPath(documentPath: string): string {
  const resolved = path.resolve(documentPath);
  const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  return `doc-${createHash('sha1').update(key).digest('hex').slice(0, 16)}`;
}

export const newUntitledSlotId = (): string => `untitled-${randomBytes(4).toString('hex')}`;

export const slotLabel = (documentPath: string | null): string =>
  documentPath === null ? 'Untitled document' : path.basename(documentPath);

function parseMeta(value: unknown): RecoverySlotMeta | null {
  if (!isRecord(value)) return null;
  const { id, path: documentPath, kind, label, changedAt, changeCount } = value;
  if (typeof id !== 'string' || !isSlotId(id) || typeof label !== 'string' || typeof changedAt !== 'string') return null;
  if (documentPath !== null && typeof documentPath !== 'string') return null;
  if ((kind !== 'document' && kind !== 'offline') || typeof changeCount !== 'number') return null;
  const { baseSha256, baseSize } = value;
  const base = typeof baseSha256 === 'string' && typeof baseSize === 'number' ? { sha256: baseSha256, size: baseSize } : null;
  return { id, path: documentPath, kind, label, changedAt, changeCount, ...baseFields(base) };
}

export interface RecoveryStore {
  readonly dir: string;
  docFile(id: string): string;
  /** The slots that still have their document, newest change first. */
  list(): RecoverySlotMeta[];
  writeMeta(meta: RecoverySlotMeta): void;
  read(id: string): { meta: RecoverySlotMeta; json: string } | null;
  remove(id: string): void;
  /** Rename a slot to a fresh id so a new document may take its name; returns the new id. */
  archive(id: string): string | null;
  /** A slot holding `json` (offline edits) with a unique id. */
  addOffline(json: string, documentPath: string | null, changeCount: number, now: Date, base: SlotBase | null): RecoverySlotMeta;
  readActive(): { id: string; path: string | null } | null;
  writeActive(id: string, documentPath: string | null): void;
  /** Move an unreadable slot aside (kept for inspection) so it cannot be overwritten. */
  quarantine(id: string): void;
}

export function createRecoveryStore(dir: string): RecoveryStore {
  const docFile = (id: string): string => path.join(dir, `${id}.json`);
  const metaFile = (id: string): string => path.join(dir, `${id}${META_SUFFIX}`);
  const readMeta = (id: string): RecoverySlotMeta | null => parseMeta(readJsonFile(metaFile(id)));
  const writeMeta = (meta: RecoverySlotMeta): void => {
    fs.mkdirSync(dir, { recursive: true });
    writeFileAtomic(metaFile(meta.id), JSON.stringify(meta));
  };
  const remove = (id: string): void => {
    if (!isSlotId(id)) return;
    for (const file of [docFile(id), `${docFile(id)}.bak`, metaFile(id)]) fs.rmSync(file, { force: true });
  };
  return {
    dir,
    docFile,
    list() {
      let names: string[];
      try {
        names = fs.readdirSync(dir);
      } catch {
        return [];
      }
      const metas: RecoverySlotMeta[] = [];
      for (const name of names) {
        if (!name.endsWith(META_SUFFIX)) continue;
        const meta = readMeta(name.slice(0, -META_SUFFIX.length));
        if (meta !== null && fs.existsSync(docFile(meta.id))) metas.push(meta);
      }
      return metas.sort((a, b) => b.changedAt.localeCompare(a.changedAt));
    },
    writeMeta,
    read(id) {
      if (!isSlotId(id)) return null;
      const meta = readMeta(id);
      if (meta === null) return null;
      try {
        return { meta, json: fs.readFileSync(docFile(id), 'utf8') };
      } catch {
        return null;
      }
    },
    remove,
    archive(id) {
      const meta = readMeta(id);
      if (meta === null || !isSlotId(id)) return null;
      const archived = `${id}-${randomBytes(3).toString('hex')}`;
      try {
        fs.renameSync(docFile(id), docFile(archived));
        fs.rmSync(`${docFile(id)}.bak`, { force: true });
        fs.rmSync(metaFile(id), { force: true });
      } catch {
        return null;
      }
      writeMeta({ ...meta, id: archived });
      return archived;
    },
    addOffline(json, documentPath, changeCount, now, base) {
      const id = `offline-${now.getTime().toString(36)}-${randomBytes(3).toString('hex')}`;
      fs.mkdirSync(dir, { recursive: true });
      writeFileAtomic(docFile(id), json);
      const meta: RecoverySlotMeta = {
        id,
        path: documentPath,
        kind: 'offline',
        label: `Offline edits of ${slotLabel(documentPath)}`,
        changedAt: now.toISOString(),
        changeCount,
        ...baseFields(base),
      };
      writeMeta(meta);
      return meta;
    },
    readActive() {
      const value = readJsonFile(path.join(dir, 'active.json'));
      if (!isRecord(value) || typeof value['id'] !== 'string' || !isSlotId(value['id'])) return null;
      const documentPath = value['path'];
      return { id: value['id'], path: typeof documentPath === 'string' ? documentPath : null };
    },
    writeActive(id, documentPath) {
      fs.mkdirSync(dir, { recursive: true });
      writeFileAtomic(path.join(dir, 'active.json'), JSON.stringify({ id, path: documentPath }));
    },
    quarantine(id) {
      try {
        fs.renameSync(docFile(id), `${docFile(id)}.unreadable-${Date.now()}`);
      } catch {
        // already gone
      }
    },
  };
}
