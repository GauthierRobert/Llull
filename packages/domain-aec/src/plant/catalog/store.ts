/** Access to `doc.plant.catalog` (user-imported piping catalogues) and catalogue resolution by id (the bundled one is addressed by code). */

import type { CadDocument } from '@core/model/types';
import { BUNDLED_CATALOG_ID, bundledCatalog } from './bundled';
import { resolveLibrary } from './libraryPort';
import type { CatalogModel, PipingCatalog, PipingLibraryReference, RatingTable } from './types';

export const EMPTY_CATALOG_MODEL: CatalogModel = { catalogs: {}, catalogOrder: [] };

export const getCatalogModel = (doc: Pick<CadDocument, 'plant'>): CatalogModel => doc.plant?.catalog ?? EMPTY_CATALOG_MODEL;

export const withCatalogModel = (doc: CadDocument, catalog: CatalogModel): CadDocument => ({ ...doc, plant: { ...doc.plant, catalog } });

const ownCatalog = (model: CatalogModel, id: string): PipingCatalog | undefined =>
  Object.hasOwn(model.catalogs, id) ? model.catalogs[id] : undefined;

/** `llull-open-piping@1.0.0` -> `llull-open-piping`: a pinned version must match the bundled version. */
export function catalogIdOf(reference: string): string {
  return reference.split('@')[0] as string;
}

/** The private library `id` (own keys only) the document references, or undefined. */
const ownLibrary = (model: CatalogModel, id: string): PipingLibraryReference | undefined =>
  model.libraries !== undefined && Object.hasOwn(model.libraries, id) ? model.libraries[id] : undefined;

/** The resolved catalogue of a referenced private library: undefined when it is not referenced or not resolvable on this machine. */
function libraryCatalog(model: CatalogModel, id: string): PipingCatalog | undefined {
  const reference = ownLibrary(model, id);
  if (reference === undefined) return undefined;
  const found = resolveLibrary(reference.libraryId, reference.version, reference.sha256);
  return found.status === 'resolved' ? found.catalog : undefined;
}

/** The bundled catalogue first, then the imported ones in import order, then the resolvable private libraries by id. */
export const allCatalogs = (doc: Pick<CadDocument, 'plant'>): PipingCatalog[] => {
  const model = getCatalogModel(doc);
  return [
    bundledCatalog(),
    ...model.catalogOrder.flatMap((id) => (Object.hasOwn(model.catalogs, id) ? model.catalogs[id] : undefined) ?? []),
    ...Object.keys(model.libraries ?? {})
      .sort()
      .flatMap((id) => libraryCatalog(model, id) ?? []),
  ];
};

/** Catalogue `reference` (id or `id@version`) in the bundled set, the document or a resolvable private library, or undefined. */
export function findCatalog(doc: Pick<CadDocument, 'plant'>, reference: string): PipingCatalog | undefined {
  const id = catalogIdOf(reference);
  const model = getCatalogModel(doc);
  const found = id === BUNDLED_CATALOG_ID ? bundledCatalog() : (ownCatalog(model, id) ?? libraryCatalog(model, id));
  const pinned = reference.includes('@') ? reference.slice(reference.indexOf('@') + 1) : undefined;
  return found !== undefined && (pinned === undefined || pinned === found.version) ? found : undefined;
}

/** Why a referenced private library does not resolve (the `PSC_LIBRARY_UNRESOLVED` text), or undefined when `reference` names no library of the document or it resolves. */
export function libraryUnresolvedReason(doc: Pick<CadDocument, 'plant'>, reference: string): string | undefined {
  const library = ownLibrary(getCatalogModel(doc), catalogIdOf(reference));
  if (library === undefined) return undefined;
  const found = resolveLibrary(library.libraryId, library.version, library.sha256);
  return found.status === 'resolved' ? undefined : found.reason;
}

/** Imported rating table `id` (own keys only), or undefined. */
export const importedRatingTable = (doc: Pick<CadDocument, 'plant'>, id: string): RatingTable | undefined => {
  const tables = getCatalogModel(doc).ratingTables;
  return tables !== undefined && Object.hasOwn(tables, id) ? tables[id] : undefined;
};

/** The imported rating tables in id order. */
export const importedRatingTables = (doc: Pick<CadDocument, 'plant'>): readonly RatingTable[] => {
  const tables = getCatalogModel(doc).ratingTables ?? {};
  return Object.keys(tables)
    .sort()
    .flatMap((id) => tables[id] ?? []);
};
