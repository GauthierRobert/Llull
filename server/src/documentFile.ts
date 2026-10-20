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

/** Atomically write `doc` to `docPath`, creating its directory; the replaced file is kept as `<docPath>.bak` (SC-D1). */
export function writeDocumentFile(docPath: string, doc: CadDocument): void {
  fs.mkdirSync(path.dirname(path.resolve(docPath)), { recursive: true });
  writeFileKeepingBackup(docPath, serializeDocument(doc));
}
