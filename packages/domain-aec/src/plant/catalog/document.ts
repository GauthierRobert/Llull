/** The `plant.catalog` slice of the document (01 PSC): validation on load. No derived entities. */

import type { DocumentExtension } from '@core/plugins/plugin';
import { isRecord } from '@lib/isRecord';
import { BUNDLED_CATALOG_ID } from './bundled';

const isDim = (value: unknown): boolean =>
  isRecord(value) &&
  typeof value['value'] === 'number' &&
  Number.isFinite(value['value']) &&
  value['value'] >= 0 &&
  ['mm', 'count', 'bar'].includes(value['unit'] as string) &&
  typeof value['verified'] === 'boolean' &&
  isRecord(value['provenance']);

function sizeErrors(size: unknown, path: string): string[] {
  if (!isRecord(size) || !isRecord(size['size']) || !isRecord(size['dims'])) return [`${path} must have size and dims`];
  const bad = Object.entries(size['dims']).filter(([, dim]) => !isDim(dim));
  return bad.map(([name]) => `${path}.dims.${name} must be { value >= 0, unit, verified, provenance }`);
}

function catalogErrors(id: string, catalog: unknown): string[] {
  const path = `plant.catalog.catalogs.${id}`;
  if (!isRecord(catalog) || catalog['format'] !== 'llull-piping-catalog' || catalog['id'] !== id || !Array.isArray(catalog['families']))
    return [`${path} must be a llull-piping-catalog with id "${id}" and families`];
  if (id === BUNDLED_CATALOG_ID) return [`${path}: the id ${BUNDLED_CATALOG_ID} is reserved for the bundled catalogue`];
  return catalog['families'].flatMap((family: unknown, index) => {
    const familyPath = `${path}.families.${index}`;
    if (!isRecord(family) || typeof family['id'] !== 'string' || !Array.isArray(family['sizes']))
      return [`${familyPath} must have id and sizes`];
    return family['sizes'].flatMap((size: unknown, k) => sizeErrors(size, `${familyPath}.sizes.${k}`));
  });
}

/** Errors of a raw `plant.catalog` value (empty when valid). */
export function pipingCatalogErrors(raw: unknown): string[] {
  if (!isRecord(raw) || !isRecord(raw['catalogs']) || !Array.isArray(raw['catalogOrder']))
    return ['plant.catalog must be { catalogs, catalogOrder }'];
  const ids = Object.keys(raw['catalogs']);
  const order = raw['catalogOrder'] as unknown[];
  const orderErrors =
    order.length === ids.length && ids.every((id) => order.includes(id))
      ? []
      : ['plant.catalog.catalogOrder must list every catalogue id once'];
  return [...orderErrors, ...ids.flatMap((id) => catalogErrors(id, (raw['catalogs'] as Record<string, unknown>)[id]))];
}

export const pipingCatalogDocument: DocumentExtension = {
  validate: (raw) => {
    const plant = raw['plant'];
    if (!isRecord(plant) || plant['catalog'] === undefined) return [];
    return pipingCatalogErrors(plant['catalog']);
  },
  derivedEntityIds: () => new Set<string>(),
  restore: (raw) => raw,
};
