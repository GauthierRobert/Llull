/** import_material_library / delete_material_library (08 MAT M3): material libraries with licence, export marking and content hash. */

import { humanGate } from '../../model/humanGate';
import { markingRank, type ExportMarking, type MaterialLibraryEntry } from '../../model/materialLibrary';
import type { CadDocument } from '../../model/types';
import type { CommandResult } from '../types';
import { defineCommand, z } from '../schema';
import { changed } from '../noop';
import { materialFromLibrary, recordsOfLibrary, refOf } from './libraryRecords';
import { loadLibrary } from './librarySource';
import { markingText } from './marking';
import { refuseMaterial } from './refusal';

const IMPORT = 'import_material_library';

/** Entity ids that use any of `materialIds`. */
const usersOf = (doc: CadDocument, materialIds: ReadonlySet<string>): string[] =>
  Object.values(doc.entities)
    .filter((entity) => entity.materialId !== undefined && materialIds.has(entity.materialId))
    .map((entity) => entity.id);

/**
 * @affects CadDocument.materialLibraries[id]; CadDocument.materials (one record per library material, values included)
 * @invariant the library hash is sha256 of its canonical JSON; records pin { libraryId, version, sha256 }; an inline library is embedded only;
 *   a private library arrives by reference and its step params carry no value (TR-MAT-31)
 * @invariant replace never lowers an export marking (library or record) without a verified human confirmation
 * @failure invalid library MAT_LIBRARY_INVALID (or the model code); licensed-no-redistribution embedded MAT_LICENCE_EMBED_FORBIDDEN; private inline
 *   MAT_LIBRARY_PRIVATE_INLINE; hash differs MAT_LIBRARY_HASH_MISMATCH; no provider / file MAT_LIBRARY_UNRESOLVED; known library without replace
 *   MAT_LIBRARY_EXISTS; id clash with a material MAT_RECORD_EXISTS; dropped record still assigned MAT_RECORD_IN_USE; replace lowering a marking without a verified confirmation MAT_HUMAN_GATE (all rejections)
 */
export const importMaterialLibrary = defineCommand({
  name: IMPORT,
  description:
    'Import a material library (format llull-material-library): records with PHY-01 values, each with basis, source, licence and export marking. ' +
    'Give the library object (inline, embedded libraries only), or { libraryId, version, sha256 } for a library file registered on this machine ' +
    '(register_material_library); a licensed library (licensed-no-redistribution) is storage private: it is read from the machine, never copied ' +
    'into the document file, and its records stay unresolved on a machine without the file until resolve_material_libraries. A sha256 that differs ' +
    'from the library content is refused (MAT_LIBRARY_HASH_MISMATCH). Imported records are read-only; assign them with assign_material. ' +
    'Another version of a known library needs replace: true (diff_material_libraries shows what changed).',
  params: z.object({
    library: z
      .record(z.string(), z.unknown())
      .optional()
      .describe(
        'The library object: { format: "llull-material-library", schemaVersion: 1, id, version, title, licence, exportMarking, storage: "embedded", sources, materials[] }.',
      ),
    libraryId: z.string().optional().describe('Id of a library file held on this machine (instead of library).'),
    version: z.string().optional().describe('Version of that library file.'),
    sha256: z.string().optional().describe('Expected content hash. Required with libraryId; optional check with an inline library.'),
    replace: z.boolean().optional().describe('Replace an already imported library of the same id (a new version); default false.'),
    confirmation: z
      .record(z.string(), z.unknown())
      .optional()
      .describe(
        'Human signature object (with a nonce), required only when replace would LOWER the export marking of the library or of a record ' +
          '(for example ITAR → none). An agent cannot give it: MAT_HUMAN_GATE.',
      ),
  }),
  run: (doc, params, ctx): CommandResult => {
    const label = params.libraryId ?? (typeof params.library?.['id'] === 'string' ? params.library['id'] : 'library');
    const refuse = (code: string, message: string, path: string, ids: readonly string[] = [label]): CommandResult =>
      refuseMaterial(doc, IMPORT, code, message, { ids, path });
    if (params.libraryId !== undefined && params.sha256 === undefined)
      return refuse('PROP_FORM_INVALID', 'a library by reference needs its sha256', 'sha256');
    const source = loadLibrary(params, ctx);
    if (!source.ok) return refuse(source.code, source.message, source.path);
    const { library, sha256 } = source;
    if (library.licence === 'licensed-no-redistribution' && library.storage === 'embedded')
      return refuse(
        'MAT_LICENCE_EMBED_FORBIDDEN',
        `library '${library.id}' is licensed-no-redistribution and cannot be embedded in a document`,
        'library.storage',
        [library.id],
      );
    const licensedRecord =
      library.storage === 'embedded' ? library.materials.find((m) => m.licence === 'licensed-no-redistribution') : undefined;
    if (licensedRecord !== undefined)
      return refuse(
        'MAT_LICENCE_EMBED_FORBIDDEN',
        `material '${licensedRecord.id}' of library '${library.id}' is licensed-no-redistribution and cannot be embedded in a document`,
        'library.materials',
        [library.id, licensedRecord.id],
      );
    if (library.storage === 'private' && source.inline)
      return refuse(
        'MAT_LIBRARY_PRIVATE_INLINE',
        `library '${library.id}' is private: its values must not travel in command params`,
        'library',
        [library.id],
      );
    if (params.sha256 !== undefined && params.sha256 !== sha256)
      return refuse('MAT_LIBRARY_HASH_MISMATCH', `library '${library.id}' hashes to ${sha256}, not ${params.sha256}`, 'sha256', [
        library.id,
      ]);
    const previous = doc.materialLibraries?.[library.id];
    if (previous !== undefined && params.replace !== true)
      return refuse('MAT_LIBRARY_EXISTS', `library '${library.id}' ${previous.version} is already imported`, 'library', [library.id]);
    const outgoing = new Set(recordsOfLibrary(doc, library.id));
    const incoming = new Set(library.materials.map((material) => material.id));
    const clash = library.materials.find((material) => Object.hasOwn(doc.materials, material.id) && !outgoing.has(material.id));
    if (clash !== undefined)
      return refuse('MAT_RECORD_EXISTS', `material '${clash.id}' already exists in the document`, 'library.materials', [clash.id]);
    const dropped = new Set([...outgoing].filter((id) => !incoming.has(id)));
    const stillUsed = usersOf(doc, dropped);
    if (stillUsed.length > 0)
      return refuse(
        'MAT_RECORD_IN_USE',
        `the new version drops record(s) ${[...dropped].join(', ')} that entities use`,
        'library',
        stillUsed,
      );
    const lowered: Array<{ id: string; from: ExportMarking; to: ExportMarking }> = [];
    if (previous !== undefined && markingRank(library.exportMarking) < markingRank(previous.exportMarking))
      lowered.push({ id: library.id, from: previous.exportMarking, to: library.exportMarking });
    for (const material of library.materials) {
      const before = outgoing.has(material.id) ? doc.materials[material.id]?.record?.exportMarking : undefined;
      if (before !== undefined && markingRank(material.exportMarking) < markingRank(before))
        lowered.push({ id: material.id, from: before, to: material.exportMarking });
    }
    if (lowered.length > 0) {
      const gate = humanGate(
        ctx?.humanSignature ?? null,
        'lowering an export marking',
        lowered.map((entry) => entry.id),
        params.confirmation,
        { lowered },
      );
      if (!gate.cleared)
        return refuse(
          'MAT_HUMAN_GATE',
          `${gate.reason} (${lowered.map((entry) => `${entry.id}: ${markingText(entry.from)} → ${markingText(entry.to)}`).join(', ')})`,
          'confirmation',
          lowered.map((entry) => entry.id),
        );
    }
    const ref = refOf(library, sha256);
    const kept = Object.fromEntries(Object.entries(doc.materials).filter(([name]) => !outgoing.has(name)));
    const materials = {
      ...kept,
      ...Object.fromEntries(library.materials.map((material) => [material.id, materialFromLibrary(doc, material, ref)])),
    };
    const entry: MaterialLibraryEntry = {
      libraryId: library.id,
      version: library.version,
      sha256,
      title: library.title,
      storage: library.storage,
      licence: library.licence,
      exportMarking: library.exportMarking,
    };
    return changed(
      { ...doc, materials, materialLibraries: { ...doc.materialLibraries, [library.id]: entry } },
      `import_material_library '${library.id}@${library.version}': ${library.materials.length} record(s) (${library.materials.map((m) => m.id).join(', ')}), ` +
        `storage ${library.storage}, licence ${library.licence}, marking ${markingText(library.exportMarking)}, sha256 ${sha256.slice(0, 12)}…${previous !== undefined ? `, replaced ${previous.version}` : ''}.`,
      [],
    );
  },
});

/**
 * @affects CadDocument.materialLibraries[libraryId] and the records that came from it (removed)
 * @invariant other libraries and materials untouched
 * @failure unknown library MAT_RECORD_NOT_FOUND; a record still assigned MAT_RECORD_IN_USE with the entity ids (rejections)
 */
export const removeMaterialLibrary = defineCommand({
  name: 'delete_material_library',
  annotations: { destructive: true },
  description:
    'Remove an imported material library and its records from the document. Refused while an entity still uses one of its records ' +
    '(MAT_RECORD_IN_USE lists the entity ids): reassign them with assign_material first.',
  params: z.object({ libraryId: z.string().describe('Id of the imported library (get_material shows record.libraryRef).') }),
  run: (doc, { libraryId }): CommandResult => {
    const command = 'delete_material_library';
    if (doc.materialLibraries?.[libraryId] === undefined)
      return refuseMaterial(doc, command, 'MAT_RECORD_NOT_FOUND', `no imported library '${libraryId}'`, {
        ids: [libraryId],
        path: 'libraryId',
      });
    const records = new Set(recordsOfLibrary(doc, libraryId));
    const users = usersOf(doc, records);
    if (users.length > 0)
      return refuseMaterial(doc, command, 'MAT_RECORD_IN_USE', `${users.length} entity(ies) use record(s) of '${libraryId}'`, {
        ids: users,
        path: 'libraryId',
      });
    const { [libraryId]: _removed, ...libraries } = doc.materialLibraries ?? {};
    void _removed;
    const materials = Object.fromEntries(Object.entries(doc.materials).filter(([name]) => !records.has(name)));
    const next: CadDocument = { ...doc, materials };
    if (Object.keys(libraries).length > 0) next.materialLibraries = libraries;
    else delete next.materialLibraries;
    return changed(next, `delete_material_library '${libraryId}': removed ${records.size} record(s) (${[...records].join(', ')}).`, []);
  },
});
