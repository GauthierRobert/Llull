/**
 * The `.llull` document file: the one reader and writer (CLI local backend, autosave, desktop).
 * Format = `serializeDocument` / `deserializeDocument`.
 */

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
}

/** null when the file does not exist. */
export function stampOf(docPath: string): FileStamp | null {
  try {
    const { mtimeMs, size } = fs.statSync(docPath);
    return { mtimeMs, size };
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

const sameStamp = (a: FileStamp | null, b: FileStamp | null): boolean =>
  a === null || b === null ? a === b : a.mtimeMs === b.mtimeMs && a.size === b.size;

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
