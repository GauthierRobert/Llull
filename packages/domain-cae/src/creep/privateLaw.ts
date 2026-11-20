/** Private-library creep laws (PHY-11 FR-CRP-20, VC-CRP-66; 08 TR-MAT-31/32): provenance and a redaction marker, never coefficients. */

import type { LibraryRef, MaterialRecordInfo } from '@core/model/materialLibrary';
import type { CadDocument, Material } from '@core/model/types';
import { creepLawOf, isLawProblem } from './law';

/** Where a private law came from: the library pin, or the record itself when a licensed record has no pin. */
export type PrivateLibrary =
  | {
      readonly kind: 'library';
      readonly libraryId: string;
      readonly version: string;
      readonly sha256: string;
      readonly storage: 'private' | 'undeclared';
      readonly licence: string;
      readonly title?: string;
    }
  | { readonly kind: 'record'; readonly recordId: string; readonly storage: 'undeclared'; readonly licence: string };

/** Short provenance label: `library 'x'` or `record 'y'`. */
export const privateLabel = (library: PrivateLibrary): string =>
  library.kind === 'library' ? `library '${library.libraryId}'` : `record '${library.recordId}'`;

function libraryFrom(doc: CadDocument, record: MaterialRecordInfo, ref: LibraryRef): PrivateLibrary {
  const entry = doc.materialLibraries?.[ref.libraryId];
  return {
    kind: 'library',
    libraryId: ref.libraryId,
    version: ref.version,
    sha256: ref.sha256,
    storage: entry === undefined ? 'undeclared' : 'private',
    licence: entry?.licence ?? record.licence,
    ...(entry !== undefined ? { title: entry.title } : {}),
  };
}

/**
 * The provenance of `materialId`'s values when they must not leave the record: a `libraryRef` that does not resolve to a declared embedded
 * library (the TR-MAT-31 stub rule, fail-closed), or a `licensed-no-redistribution` record or library (TR-MAT-32), pinned or not; null otherwise.
 * @invariant fails closed: a pin to an undeclared library, or a licensed record without a pin, counts as private
 */
export function privateLibraryOf(doc: CadDocument, materialId: string): PrivateLibrary | null {
  const record = Object.hasOwn(doc.materials, materialId) ? doc.materials[materialId]?.record : undefined;
  if (record === undefined) return null;
  const ref = record.libraryRef;
  const entry = ref === undefined ? undefined : doc.materialLibraries?.[ref.libraryId];
  const licensed = record.licence === 'licensed-no-redistribution' || entry?.licence === 'licensed-no-redistribution';
  if (ref === undefined) return licensed ? { kind: 'record', recordId: record.id, storage: 'undeclared', licence: record.licence } : null;
  return entry?.storage === 'embedded' && !licensed ? null : libraryFrom(doc, record, ref);
}

/** A private-library stub whose values are not on this machine (`record.unresolved`, pinned). */
export type UnresolvedStub = Material & {
  readonly record: MaterialRecordInfo & {
    readonly unresolved: NonNullable<MaterialRecordInfo['unresolved']>;
    readonly libraryRef: LibraryRef;
  };
};

const isUnresolvedStub = (material: Material | null | undefined): material is UnresolvedStub =>
  material?.record?.unresolved !== undefined && material.record.libraryRef !== undefined;

/** The stub of `materialId` (an own key of the document), or null. */
export function unresolvedStubOf(doc: CadDocument, materialId: string): UnresolvedStub | null {
  const material = Object.hasOwn(doc.materials, materialId) ? doc.materials[materialId] : undefined;
  return isUnresolvedStub(material) ? material : null;
}

interface UnresolvedMaterial {
  readonly materialId: string;
  readonly parts: string[];
  readonly reason: string;
  readonly library: PrivateLibrary;
}

/** Materials of the parts of an analysis that are unresolved private-library stubs, with the parts that use them. */
export function unresolvedPartMaterials(doc: CadDocument, partIds: readonly string[]): UnresolvedMaterial[] {
  const found: UnresolvedMaterial[] = [];
  for (const entityId of partIds) {
    const materialId = Object.hasOwn(doc.entities, entityId) ? doc.entities[entityId]?.materialId : undefined;
    const stub = materialId === undefined ? null : unresolvedStubOf(doc, materialId);
    if (materialId === undefined || stub === null) continue;
    const same = found.find((entry) => entry.materialId === materialId);
    if (same !== undefined) same.parts.push(entityId);
    else
      found.push({
        materialId,
        parts: [entityId],
        reason: stub.record.unresolved.reason,
        library: libraryFrom(doc, stub.record, stub.record.libraryRef),
      });
  }
  return found;
}

/**
 * Part materials of analysis `analysisId` whose creep law comes from a private library (privateLibraryOf): a deck written for the user would carry
 * their *CREEP coefficients, so an export of it refuses (FR-CRP-20); the in-memory deck of a local solve does not use this.
 * @invariant empty for an unknown case, a part without material, or a private material without a creep law
 */
export function privateCreepLawMaterials(doc: CadDocument, analysisId: string): string[] {
  const analysis = doc.analysis?.cases[analysisId];
  if (analysis === undefined) return [];
  const found = new Set<string>();
  for (const entityId of Object.keys(analysis.parts)) {
    const materialId = Object.hasOwn(doc.entities, entityId) ? doc.entities[entityId]?.materialId : undefined;
    const material = materialId !== undefined && Object.hasOwn(doc.materials, materialId) ? doc.materials[materialId] : undefined;
    if (materialId === undefined || material === undefined || privateLibraryOf(doc, materialId) === null) continue;
    if (!isLawProblem(creepLawOf(material, materialId))) found.add(materialId);
  }
  return [...found];
}

export const REDACTED_LAW = 'private: coefficients withheld (private material library, TR-MAT-31/32); the library pin is the provenance';
