/** Access to `doc.plant.catalog` (user-imported piping catalogues) and catalogue resolution by id (the bundled one is addressed by code). */

import type { CadDocument } from '@core/model/types';
import { BUNDLED_CATALOG_ID, bundledCatalog } from './bundled';
import type { CatalogModel, PipingCatalog, RatingTable } from './types';

export const EMPTY_CATALOG_MODEL: CatalogModel = { catalogs: {}, catalogOrder: [] };

export const getCatalogModel = (doc: Pick<CadDocument, 'plant'>): CatalogModel => doc.plant?.catalog ?? EMPTY_CATALOG_MODEL;

export const withCatalogModel = (doc: CadDocument, catalog: CatalogModel): CadDocument => ({ ...doc, plant: { ...doc.plant, catalog } });

const ownCatalog = (model: CatalogModel, id: string): PipingCatalog | undefined =>
  Object.hasOwn(model.catalogs, id) ? model.catalogs[id] : undefined;

/** `llull-open-piping@1.0.0` -> `llull-open-piping`: a pinned version must match the bundled version. */
export function catalogIdOf(reference: string): string {
  return reference.split('@')[0] as string;
}

/** The bundled catalogue first, then the imported ones in import order. */
export const allCatalogs = (doc: Pick<CadDocument, 'plant'>): PipingCatalog[] => {
  const model = getCatalogModel(doc);
  return [
    bundledCatalog(),
    ...model.catalogOrder.flatMap((id) => (Object.hasOwn(model.catalogs, id) ? model.catalogs[id] : undefined) ?? []),
  ];
};

/** Catalogue `reference` (id or `id@version`) in the bundled set or the document, or undefined. */
export function findCatalog(doc: Pick<CadDocument, 'plant'>, reference: string): PipingCatalog | undefined {
  const id = catalogIdOf(reference);
  const found = id === BUNDLED_CATALOG_ID ? bundledCatalog() : ownCatalog(getCatalogModel(doc), id);
  const pinned = reference.includes('@') ? reference.slice(reference.indexOf('@') + 1) : undefined;
  return found !== undefined && (pinned === undefined || pinned === found.version) ? found : undefined;
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
