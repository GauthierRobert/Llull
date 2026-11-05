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

/** null when the file does not exist. */
export function stampOf(docPath: string): FileStamp | null {
  try {
    const { mtimeMs, size } = fs.statSync(docPath);
    const sha256 = size <= HASH_LIMIT_BYTES ? createHash('sha256').update(fs.readFileSync(docPath)).digest('hex') : null;
    return { mtimeMs, size, sha256 };
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

/**
 * The same file content, by what can be known. Sizes differ -> changed. Same size -> compare the content hash: a touched time stamp
 * (cloud sync, antivirus) is no change, and a same-size rewrite inside a coarse time-stamp granularity (FAT: 2 s) is still caught.
 */
const sameStamp = (a: FileStamp | null, b: FileStamp | null): boolean => {
  if (a === null || b === null) return a === b;
  if (a.size !== b.size) return false;
  return a.sha256 !== null && b.sha256 !== null ? a.sha256 === b.sha256 : a.mtimeMs === b.mtimeMs;
};

/**
 * Atomically write `doc` to `docPath`, creating its directory; the replaced file is kept as `<docPath>.bak` (SC-D1). Returns the stamp of
 * the file written.
 * @param expected when given, the stamp the file had when this process loaded or last saved it (null: it did not exist)
 * @failure the file on disk is not what `expected` says -> SaveConflictError (DSF_SAVE_CONFLICT); nothing is written
 */
export function writeDocumentFile(docPath: string, doc: CadDocument, expected?: { readonly stamp: FileStamp | null }): FileStamp | null {
  if (expected !== undefined && !sameStamp(stampOf(docPath), expected.stamp)) throw new SaveConflictError(path.resolve(docPath));
  fs.mkdirSync(path.dirname(path.resolve(docPath)), { recursive: true });
  writeFileKeepingBackup(docPath, serializeDocument(doc));
  return stampOf(docPath);
}
