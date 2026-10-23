/** Access to `doc.plant.catalog` (user-imported piping catalogues) and catalogue resolution by id (the bundled one is addressed by code). */

import type { CadDocument } from '@core/model/types';
import { BUNDLED_CATALOG_ID, bundledCatalog } from './bundled';
import type { CatalogModel, PipingCatalog } from './types';

export const EMPTY_CATALOG_MODEL: CatalogModel = { catalogs: {}, catalogOrder: [] };

export const getCatalogModel = (doc: Pick<CadDocument, 'plant'>): CatalogModel => doc.plant?.catalog ?? EMPTY_CATALOG_MODEL;

export const withCatalogModel = (doc: CadDocument, catalog: CatalogModel): CadDocument => ({ ...doc, plant: { ...doc.plant, catalog } });

/** `llull-open-piping@1.0.0` -> `llull-open-piping`: a pinned version must match the bundled version. */
export function catalogIdOf(reference: string): string {
  return reference.split('@')[0] as string;
}

/** The bundled catalogue first, then the imported ones in import order. */
export const allCatalogs = (doc: Pick<CadDocument, 'plant'>): PipingCatalog[] => {
  const model = getCatalogModel(doc);
  return [bundledCatalog(), ...model.catalogOrder.flatMap((id) => model.catalogs[id] ?? [])];
};

/** Catalogue `reference` (id or `id@version`) in the bundled set or the document, or undefined. */
export function findCatalog(doc: Pick<CadDocument, 'plant'>, reference: string): PipingCatalog | undefined {
  const id = catalogIdOf(reference);
  const found = id === BUNDLED_CATALOG_ID ? bundledCatalog() : getCatalogModel(doc).catalogs[id];
  const pinned = reference.includes('@') ? reference.slice(reference.indexOf('@') + 1) : undefined;
  return found !== undefined && (pinned === undefined || pinned === found.version) ? found : undefined;
}
