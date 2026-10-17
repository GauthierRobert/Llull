/** resolve_material_libraries (08 MAT TR-MAT-16, OQ-MAT-09): fill the records of private libraries from this machine's library files. */

import { stricterMarking, type MaterialLibrary, type UnresolvedReason } from '../../model/materialLibrary';
import type { CadDocument, Material } from '../../model/types';
import type { CommandResult, ExecutionContext } from '../types';
import { defineCommand, z } from '../schema';
import { report } from '../noop';
import { parseMaterialLibrary } from './libraryFormat';
import { materialFromLibrary, recordsOfLibrary, stubOf } from './libraryRecords';

type Reading = { readonly library: MaterialLibrary } | { readonly reason: UnresolvedReason };

/** The pinned library from the machine's provider, or why it cannot be used. */
function readLibrary(ctx: ExecutionContext | undefined, libraryId: string, version: string, sha256: string): Reading {
  const provider = ctx?.libraries ?? null;
  if (provider === null) return { reason: 'provider missing' };
  const raw = provider.get(libraryId, version);
  if (raw === null) return { reason: 'library missing' };
  const parsed = parseMaterialLibrary(raw);
  if (!parsed.ok) return { reason: 'library missing' };
  return parsed.sha256 === sha256 ? { library: parsed.library } : { reason: 'hash mismatch' };
}

/** The record filled from `library`, keeping the document's colours and the stricter export marking. */
function filled(material: Material, library: MaterialLibrary, name: string, units: Pick<CadDocument, 'units'>): Material {
  const ref = material.record?.libraryRef;
  const source = library.materials.find((candidate) => candidate.id === name);
  if (ref === undefined) return material;
  if (source === undefined) return stubOf(material, 'library missing');
  const fresh = materialFromLibrary(units, source, ref);
  const marking = stricterMarking(material.record?.exportMarking ?? source.exportMarking, source.exportMarking);
  return {
    ...fresh,
    color: material.color,
    metalness: material.metalness,
    roughness: material.roughness,
    ...(fresh.record !== undefined ? { record: { ...fresh.record, exportMarking: marking } } : {}),
  };
}

/**
 * @affects CadDocument.materials (records of private libraries: values filled or marked unresolved); no FeatureStep (session command)
 * @invariant fills a record only when the provider's library has exactly the pinned sha256; never touches an embedded record; the stricter of the
 *   record's and the library's export marking is kept; a different version or hash leaves the record unresolved
 * @failure provider missing / library missing / hash mismatch -> the records stay unresolved with that reason (a warning in data, not a refusal)
 */
export const resolveMaterialLibraries = defineCommand({
  name: 'resolve_material_libraries',
  annotations: { session: true, idempotent: true },
  description:
    'Fill the records of private (licensed) material libraries from the library files held on this machine. A saved document keeps only ' +
    '{ libraryId, version, sha256 } for them; run this after load_document. A record is filled only when the file has exactly the pinned sha256; ' +
    'otherwise it stays unresolved (provider missing, library missing or hash mismatch) and mass_properties / get_material_allowable answer ' +
    'available: false with MAT_LIBRARY_UNRESOLVED. This is a session command: it is not recorded in the feature history and never saved. ' +
    'Register a file first with register_material_library; import a new version explicitly with import_material_library.',
  params: z.object({}),
  run: (doc, _params, ctx): CommandResult => {
    const resolved: string[] = [];
    const unresolved: { libraryId: string; reason: UnresolvedReason; records: string[] }[] = [];
    const materials: Record<string, Material> = { ...doc.materials };
    for (const entry of Object.values(doc.materialLibraries ?? {})) {
      if (entry.storage !== 'private') continue;
      const records = recordsOfLibrary(doc, entry.libraryId);
      const read = readLibrary(ctx, entry.libraryId, entry.version, entry.sha256);
      if ('reason' in read) {
        for (const name of records) {
          const material = materials[name];
          if (material !== undefined) materials[name] = stubOf(material, read.reason);
        }
        unresolved.push({ libraryId: entry.libraryId, reason: read.reason, records });
        continue;
      }
      for (const name of records) {
        const material = materials[name];
        if (material === undefined) continue;
        const next = filled(material, read.library, name, doc);
        materials[name] = next;
        if (next.record?.unresolved === undefined) resolved.push(name);
        else unresolved.push({ libraryId: entry.libraryId, reason: next.record.unresolved.reason, records: [name] });
      }
    }
    const unchanged = JSON.stringify(materials) === JSON.stringify(doc.materials);
    return report(
      unchanged ? doc : { ...doc, materials },
      `resolve_material_libraries: ${resolved.length} record(s) resolved${resolved.length > 0 ? ` (${resolved.join(', ')})` : ''}` +
        `${unresolved.length > 0 ? `; MAT_LIBRARY_UNRESOLVED ${unresolved.map((u) => `${u.libraryId} (${u.reason}: ${u.records.join(', ')})`).join('; ')}` : ''}.`,
      {
        resolved,
        unresolved,
        warnings: unresolved.map((u) => ({ code: 'MAT_LIBRARY_UNRESOLVED', libraryId: u.libraryId, reason: u.reason, ids: u.records })),
      },
    );
  },
});
