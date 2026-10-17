/**
 * Export gate (TR-MAT-30 / 32 / 51, VC-MAT-15 / 25): content of a record marked ITAR or EAR (with an ECCN) does not leave the machine without
 * a human. `exportGate` is the pure check (core, also called by the server for share / cloud paths); `exportRefusal` is what each export
 * command runs first.
 */

import { isControlledMarking, markingRank, type ExportMarking } from '../../model/materialLibrary';
import type { CadDocument } from '../../model/types';
import { z } from '../schema';
import type { CommandResult, ExecutionContext } from '../types';
import { humanGate } from './humanGate';
import { materialsInUse } from './materialsInUse';
import { refuseMaterial } from './refusal';

export type ExportTarget = 'step' | 'gltf' | 'stl' | 'obj' | 'code' | 'save' | 'share';

interface MarkedItem {
  readonly kind: 'record' | 'library';
  readonly id: string;
  readonly marking: ExportMarking;
}

export type ExportGate =
  | { readonly controlled: false }
  | { readonly controlled: true; readonly marking: ExportMarking; readonly items: readonly MarkedItem[]; readonly ids: readonly string[] };

/**
 * Controlled markings among the records assigned to an entity of `doc` and the libraries they came from.
 * @invariant the document marking is the strictest one found; unresolved private stubs keep their marking, so they still gate
 */
export function exportGate(doc: CadDocument, _target: ExportTarget): ExportGate {
  const inUse = new Set(materialsInUse(doc).keys());
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

/** The optional param every export command takes. */
export const confirmExportControlled = z
  .union([z.boolean(), z.record(z.string(), z.unknown())])
  .optional()
  .describe(
    'Human confirmation for a document that uses export-controlled (ITAR / EAR) material records: a signature object produced in the desktop ' +
      'app. An agent cannot give it: true is refused with MAT_HUMAN_GATE. Without it a controlled document is refused with MAT_EXPORT_CONTROLLED.',
  );

/**
 * Refusal of an export of controlled content, or null when the export may proceed.
 * @failure controlled content without confirmation -> MAT_EXPORT_CONTROLLED; with a bare true / no signing port / unverified signature -> MAT_HUMAN_GATE
 */
export function exportRefusal(
  doc: CadDocument,
  command: string,
  target: ExportTarget,
  confirmation: unknown,
  ctx: ExecutionContext | undefined,
): CommandResult | null {
  const gate = exportGate(doc, target);
  if (!gate.controlled) return null;
  const regime = gate.marking.regime;
  if (confirmation === undefined || confirmation === false)
    return refuseMaterial(
      doc,
      command,
      'MAT_EXPORT_CONTROLLED',
      `the document uses ${regime}-marked material(s) ${gate.ids.join(', ')}; nothing was exported`,
      { ids: gate.ids, path: 'document' },
    );
  const outcome = humanGate(ctx, `export of ${regime}-controlled content`, gate.ids, confirmation);
  return outcome.cleared
    ? null
    : refuseMaterial(doc, command, 'MAT_HUMAN_GATE', `${outcome.reason}; nothing was exported`, {
        ids: gate.ids,
        path: 'confirmExportControlled',
      });
}
