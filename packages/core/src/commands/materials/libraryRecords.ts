/**
 * Library material → document `Material` (an imported record) and the private-library stub (TR-MAT-31). An imported record is a `Material`
 * whose `record.libraryRef` pins the library; its values are PHY-01 models; the legacy `density` mirrors the resolved density model.
 */

import { resolveDensity } from '../../geometry/resolveDensity';
import type { LibraryMaterial, LibraryRef, MaterialLibrary, UnresolvedReason } from '../../model/materialLibrary';
import type { PropertyModel } from '../../model/propertyModel';
import type { CadDocument, Material } from '../../model/types';
import { rehashed } from './libraryFormat';

const DEFAULT_COLOR = '#b0b0b0';
const DEFAULT_METALNESS = 0.8;
const DEFAULT_ROUGHNESS = 0.4;

/** Legacy `Material.density` (g per document unit³) mirroring the density the material resolves to; unchanged while it resolves to none. */
export function mirroredDensity(doc: Pick<CadDocument, 'units'>, name: string, material: Material): number {
  const resolved = resolveDensity({ units: doc.units, materials: { [name]: material } }, name);
  return resolved?.available === true ? resolved.gPerDocUnit3 : material.density;
}

/** The material with its legacy density re-derived from its models. */
export function withMirroredDensity(doc: Pick<CadDocument, 'units'>, name: string, material: Material): Material {
  return { ...material, density: mirroredDensity(doc, name, material) };
}

/** Record fields of a library material, pinned to `ref`. */
function recordOf(source: LibraryMaterial, ref: LibraryRef): NonNullable<Material['record']> {
  return {
    id: source.id,
    designation: source.designation,
    ...(source.temper !== undefined ? { temper: source.temper } : {}),
    ...(source.productForm !== undefined ? { productForm: source.productForm } : {}),
    specs: source.specs,
    licence: source.licence,
    exportMarking: source.exportMarking,
    ...(source.superseded !== undefined ? { superseded: source.superseded } : {}),
    libraryRef: ref,
  };
}

/** The document material of library material `source` (models carry recomputed coefficient hashes). */
export function materialFromLibrary(doc: Pick<CadDocument, 'units'>, source: LibraryMaterial, ref: LibraryRef): Material {
  const propertyModels: readonly PropertyModel[] = source.propertyModels.map(rehashed);
  const material: Material = {
    name: source.id,
    density: 0,
    color: source.color ?? DEFAULT_COLOR,
    metalness: source.metalness ?? DEFAULT_METALNESS,
    roughness: source.roughness ?? DEFAULT_ROUGHNESS,
    propertyModels,
    record: recordOf(source, ref),
  };
  return withMirroredDensity(doc, source.id, material);
}

/** Material ids of `doc` that came from library `libraryId`. */
export const recordsOfLibrary = (doc: CadDocument, libraryId: string): string[] =>
  Object.entries(doc.materials)
    .filter(([, material]) => material.record?.libraryRef?.libraryId === libraryId)
    .map(([name]) => name);

/** The library's own reference (id, version, content hash). */
export const refOf = (library: MaterialLibrary, sha256: string): LibraryRef => ({
  libraryId: library.id,
  version: library.version,
  sha256,
});

/**
 * A private-library record without its values (what a saved file keeps): identification, library pin and render colours only.
 * @invariant no property model, no density, no material law
 */
export function stubOf(material: Material, reason: UnresolvedReason): Material {
  const { propertyModels: _models, materialModels: _laws, constitutiveSets: _sets, defaultConstitutiveSet: _default, ...rest } = material;
  void [_models, _laws, _sets, _default];
  return { ...rest, density: 0, ...(rest.record !== undefined ? { record: { ...rest.record, unresolved: { reason } } } : {}) };
}

/** Why `material` must not keep its values in a saved file, or null when it may (no library pin, or a declared embedded library). */
const strippedReason = (doc: Pick<CadDocument, 'materialLibraries'>, material: Material): UnresolvedReason | null => {
  const ref = material.record?.libraryRef;
  if (ref === undefined) return null;
  const entry = doc.materialLibraries?.[ref.libraryId];
  if (entry === undefined) return 'library missing';
  return entry.storage === 'embedded' ? null : 'provider missing';
};

/**
 * `doc` with every record of a non-embedded library reduced to its stub (TR-MAT-31): what is saved, snapshotted and sent to live-sync clients.
 * @invariant fails closed: a record whose `libraryRef` does not resolve to a declared embedded library is stubbed; returns `doc` itself when none is
 */
export function withoutPrivateValues(doc: CadDocument): CadDocument {
  const stubbed = Object.entries(doc.materials).filter(([, material]) => strippedReason(doc, material) !== null);
  if (stubbed.length === 0) return doc;
  const materials = { ...doc.materials };
  for (const [name, material] of stubbed)
    materials[name] = stubOf(material, material.record?.unresolved?.reason ?? strippedReason(doc, material) ?? 'provider missing');
  return { ...doc, materials };
}
