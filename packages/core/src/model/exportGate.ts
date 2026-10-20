/**
 * Export gate (TR-MAT-30 / 32 / 51, VC-MAT-15 / 25): content of a record marked ITAR or EAR (with an ECCN) does not leave the machine without
 * a human. `exportGate` is the pure check (also called by the server for share / cloud paths); `exportRefusal` (commands/noop) is what each
 * export command runs first. Lives in the model so domain plugins and the server reach it through the public API.
 */

import { canonicalJson } from '../lib/canonicalJson';
import { sha256Hex } from '../lib/sha256';
import { isControlledMarking, markingRank, type ExportMarking } from './materialLibrary';
import { materialsInUse } from './materialsInUse';
import type { CadDocument } from './types';

export type ExportTarget =
  | 'step'
  | 'iges'
  | 'gltf'
  | 'stl'
  | 'obj'
  | '3mf'
  | 'urdf'
  | 'code'
  | 'save'
  | 'share'
  | 'sheet'
  | 'deck'
  | 'data';

interface MarkedItem {
  readonly kind: 'record' | 'library';
  readonly id: string;
  readonly marking: ExportMarking;
}

export type ExportGate =
  | { readonly controlled: false }
  | { readonly controlled: true; readonly marking: ExportMarking; readonly items: readonly MarkedItem[]; readonly ids: readonly string[] };

export const EXPORT_REMEDIATION = {
  MAT_EXPORT_CONTROLLED: 'hand over to a human (export-control officer); ask the owner to confirm in the desktop app',
  MAT_HUMAN_GATE: 'ask the owner to do it in the desktop app (a verified human signature is required)',
} as const;

/**
 * Controlled markings among the records assigned to an entity of `doc` and the libraries they came from.
 * @invariant `emitted` names materials whose values are exported although no entity uses them (export_material_cards)
 * @invariant the document marking is the strictest one found; unresolved private stubs keep their marking, so they still gate
 */
export function exportGate(doc: CadDocument, _target: ExportTarget, emitted: readonly string[] = []): ExportGate {
  const inUse = new Set([...materialsInUse(doc).keys(), ...emitted]);
  const items: MarkedItem[] = [];
  const libraries = new Set<string>();
  for (const name of [...inUse].sort()) {
    const record = Object.hasOwn(doc.materials, name) ? doc.materials[name]?.record : undefined;
    if (record === undefined) continue;
    if (isControlledMarking(record.exportMarking)) items.push({ kind: 'record', id: name, marking: record.exportMarking });
    if (record.libraryRef !== undefined) libraries.add(record.libraryRef.libraryId);
  }
  for (const libraryId of [...libraries].sort()) {
    const marking = doc.materialLibraries?.[libraryId]?.exportMarking;
    if (marking !== undefined && isControlledMarking(marking)) items.push({ kind: 'library', id: libraryId, marking });
  }
  const strictest = items.reduce<ExportMarking | null>(
    (worst, item) => (worst === null || markingRank(item.marking) > markingRank(worst) ? item.marking : worst),
    null,
  );
  return strictest === null ? { controlled: false } : { controlled: true, marking: strictest, items, ids: items.map((item) => item.id) };
}

/** Hash of the document being exported (selection excluded): the human's export signature is bound to exactly this content. */
export const exportDocumentHash = (doc: CadDocument): string => sha256Hex(canonicalJson({ ...doc, selection: [] }));
