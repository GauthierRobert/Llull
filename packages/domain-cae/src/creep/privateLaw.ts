/** Private-library creep laws in `creep_report` (PHY-11 FR-CRP-20, VC-CRP-66; 08 TR-MAT-31/32): provenance and a redaction marker, never coefficients. */

import type { CadDocument } from '@core/model/types';

/** Where a private record's law came from: library pin, storage and licence (what a saved file also keeps). */
export interface PrivateLibrary {
  readonly libraryId: string;
  readonly version: string;
  readonly sha256: string;
  readonly storage: 'private' | 'undeclared';
  readonly licence: string;
  readonly title?: string;
}

/**
 * The library behind `materialId` when its values must not leave the record: a `libraryRef` that does not resolve to a declared embedded
 * library (the TR-MAT-31 stub rule, fail-closed), or a `licensed-no-redistribution` record or library (TR-MAT-32); null otherwise.
 * @invariant fails closed: a pin to an undeclared library counts as private
 */
export function privateLibraryOf(doc: CadDocument, materialId: string): PrivateLibrary | null {
  const record = Object.hasOwn(doc.materials, materialId) ? doc.materials[materialId]?.record : undefined;
  if (record === undefined) return null;
  const ref = record.libraryRef;
  const entry = ref === undefined ? undefined : doc.materialLibraries?.[ref.libraryId];
  const licensed = record.licence === 'licensed-no-redistribution' || entry?.licence === 'licensed-no-redistribution';
  if (ref === undefined || (entry?.storage === 'embedded' && !licensed)) return null;
  return {
    libraryId: ref.libraryId,
    version: ref.version,
    sha256: ref.sha256,
    storage: entry === undefined ? 'undeclared' : 'private',
    licence: entry?.licence ?? record.licence,
    ...(entry !== undefined ? { title: entry.title } : {}),
  };
}

/** Materials of the parts of an analysis whose private-library values are not on this machine (stubs with `record.unresolved`). */
export function unresolvedPartMaterials(
  doc: CadDocument,
  partIds: readonly string[],
): { readonly materialId: string; readonly parts: string[]; readonly reason: string; readonly library: PrivateLibrary | null }[] {
  const found: { materialId: string; parts: string[]; reason: string; library: PrivateLibrary | null }[] = [];
  for (const entityId of partIds) {
    const materialId = Object.hasOwn(doc.entities, entityId) ? doc.entities[entityId]?.materialId : undefined;
    const material = materialId !== undefined && Object.hasOwn(doc.materials, materialId) ? doc.materials[materialId] : undefined;
    const unresolved = material?.record?.unresolved;
    if (materialId === undefined || unresolved === undefined) continue;
    const same = found.find((entry) => entry.materialId === materialId);
    if (same !== undefined) same.parts.push(entityId);
    else found.push({ materialId, parts: [entityId], reason: unresolved.reason, library: privateLibraryOf(doc, materialId) });
  }
  return found;
}

export const REDACTED_LAW = 'private: coefficients withheld (private material library, TR-MAT-31/32); the library pin is the provenance';
