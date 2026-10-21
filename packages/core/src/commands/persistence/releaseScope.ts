/** document_content_hash: the canonical release-scope bytes of a document and their SHA-256 (09 PLM FR-PLM-06, TR-PLM-17). */

import type { CadDocument } from '../../model/types';
import { jcsJson } from '../../lib/jcs';
import { sha256Hex } from '../../lib/sha256';
import type { CommandResult } from '../types';
import { defineCommand, z } from '../schema';
import { withoutPrivateValues } from '../materials/libraryRecords';
import { withoutDerivedEntities } from './serialization';
import { documentExtensions } from '../../plugins/host';

/**
 * Pinned scope format (not the file envelope version): a schema bump never changes the hash of an unchanged definition.
 * @invariant 2 is the version the published golden vectors (docs/aerospace/09 validation) were generated with
 */
const SCOPE_FORMAT_VERSION = 2;

/**
 * Canonical JSON of the release scope: the saved definition (derived entities and private library values omitted) minus view state
 * (`selection`, `camera`) and the keys plugins declare outside the release scope (the PLM record).
 * @invariant a function of the definition alone: camera / selection / PLM edits and key order never change it
 */
export function releaseScopeJson(doc: CadDocument): string {
  const { selection: _selection, camera: _camera, ...scoped } = withoutPrivateValues(withoutDerivedEntities(doc));
  void [_selection, _camera];
  const excluded = new Set(documentExtensions().flatMap((extension) => extension.outsideReleaseScope ?? []));
  const definition = Object.fromEntries(Object.entries(scoped).filter(([key]) => !excluded.has(key)));
  return jcsJson({ format: 'llull-document', version: SCOPE_FORMAT_VERSION, document: definition });
}

/**
 * @affects nothing (read-only)
 * @invariant `sha256` = SHA-256 of the UTF-8 bytes of `canonicalJson`; `bytes` is that byte length
 */
export const documentContentHash = defineCommand({
  name: 'document_content_hash',
  description:
    'Compute the content hash of the document definition: SHA-256 (lowercase hex) of its canonical JSON (RFC 8785 key order) after dropping view ' +
    'state (selection, camera), the PLM record and plugin-derived geometry. Equal definitions hash equally whatever the key order; any edit of ' +
    'entities, history, parameters, materials, drawings... changes it. Returns data { sha256, bytes, canonicalJson? }. Read-only.',
  annotations: { readOnly: true },
  params: z.object({
    includeCanonical: z.boolean().optional().describe('Also return the exact canonical text that was hashed (large). Default false.'),
  }),
  run: (doc, { includeCanonical }): CommandResult => {
    const text = releaseScopeJson(doc);
    const sha256 = sha256Hex(text);
    const bytes = new TextEncoder().encode(text).length;
    return {
      document: doc,
      summary: `Content hash sha256 ${sha256} over ${bytes} bytes of canonical release-scope JSON.`,
      affected: [],
      data: { sha256, bytes, ...(includeCanonical === true ? { canonicalJson: text } : {}) },
    };
  },
});
