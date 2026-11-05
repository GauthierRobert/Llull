/**
 * The `.llull` document file: the one reader and writer (CLI local backend, autosave, desktop).
 * Format = `serializeDocument` / `deserializeDocument`.
 */

import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import { serializeDocument, deserializeDocument } from '@core/commands/persistence/serialization';
import { type CadDocument, createEmptyDocument } from '@core/model/types';
import { writeFileKeepingBackup } from './writeFileAtomic';

/** The document stored at `docPath`; an empty document when the file does not exist yet. */
export function readDocumentFile(docPath: string): CadDocument {
  if (!fs.existsSync(docPath)) return createEmptyDocument();
  return deserializeDocument(fs.readFileSync(docPath, 'utf8'));
}

/** What the file looked like when it was loaded or last saved: a save checks it before replacing the file (DSF_SAVE_CONFLICT). */
export interface FileStamp {
  readonly mtimeMs: number;
  readonly size: number;
  /** SHA-256 of the content; null for a file above HASH_LIMIT_BYTES (the time stamp decides then). */
  readonly sha256: string | null;
}

const HASH_LIMIT_BYTES = 512 * 1024 * 1024;

const statOf = (docPath: string): { mtimeMs: number; size: number } | null => {
  try {
    const { mtimeMs, size } = fs.statSync(docPath);
    return { mtimeMs, size };
  } catch {
    return null;
  }
};

/** null when the file does not exist. */
export function stampOf(docPath: string): FileStamp | null {
  const stat = statOf(docPath);
  if (stat === null) return null;
  try {
    return { ...stat, sha256: stat.size <= HASH_LIMIT_BYTES ? createHash('sha256').update(fs.readFileSync(docPath)).digest('hex') : null };
  } catch {
    return null;
  }
}

export class SaveConflictError extends Error {
  readonly code = 'DSF_SAVE_CONFLICT';
  constructor(readonly documentPath: string) {
    super(
      `DSF_SAVE_CONFLICT: ${path.basename(documentPath)} changed on disk since it was opened; saving would overwrite those changes. ` +
        'Save under another name, or overwrite on purpose.',
    );
    this.name = 'SaveConflictError';
  }
}

const FAT_GRANULARITY_MS = 2000;

/**
 * The file at `docPath` is what `expected` says, by the cheapest proof that holds. Missing / existing, then size, then the time stamp:
 * the same size and the same time stamp is no change, which spares hashing a large document at every save. A touched time stamp (cloud sync,
 * antivirus) with the same content is no change either (the hash decides). Caveat: a coarse time stamp (FAT: 2 s) lets a same-size rewrite
 * keep it, so while the stamp is younger than that the hash decides as well.
 */
function unchangedOnDisk(docPath: string, expected: FileStamp | null): boolean {
  const current = statOf(docPath);
  if (current === null || expected === null) return current === expected;
  if (current.size !== expected.size) return false;
  const sameTime = current.mtimeMs === expected.mtimeMs;
  if (sameTime && (expected.sha256 === null || Date.now() - expected.mtimeMs > FAT_GRANULARITY_MS)) return true;
  if (expected.sha256 === null) return false;
  return stampOf(docPath)?.sha256 === expected.sha256;
}

/**
 * Atomically write `doc` to `docPath`, creating its directory; the replaced file is kept as `<docPath>.bak` (SC-D1). Returns the stamp of
 * the file written.
 * @param expected when given, the stamp the file had when this process loaded or last saved it (null: it did not exist)
 * @failure the file on disk is not what `expected` says -> SaveConflictError (DSF_SAVE_CONFLICT); nothing is written
 */
export function writeDocumentFile(docPath: string, doc: CadDocument, expected?: { readonly stamp: FileStamp | null }): FileStamp | null {
  if (expected !== undefined && !unchangedOnDisk(docPath, expected.stamp)) throw new SaveConflictError(path.resolve(docPath));
  fs.mkdirSync(path.dirname(path.resolve(docPath)), { recursive: true });
  const text = serializeDocument(doc);
  writeFileKeepingBackup(docPath, text);
  // The hash is of the bytes just written (never read back: a large document is hashed once, not re-read).
  const stat = statOf(docPath);
  const size = Buffer.byteLength(text, 'utf8');
  return stat === null
    ? null
    : { mtimeMs: stat.mtimeMs, size, sha256: size <= HASH_LIMIT_BYTES ? createHash('sha256').update(text, 'utf8').digest('hex') : null };
}
