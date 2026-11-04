/** The `plant.catalog` slice of the document (01 PSC): validation on load. No derived entities. */

import type { DocumentExtension } from '@core/plugins/plugin';
import { isRecord } from '@lib/isRecord';
import { pipeSpecErrors } from '../spec/document';
import { squash } from './ptRating';
import { BUNDLED_CATALOG_ID, BUNDLED_RATING_TABLE_ID } from './bundled';

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

const isRatingRow = (row: unknown): boolean =>
  isRecord(row) &&
  typeof row['ratingClass'] === 'number' &&
  Number.isFinite(row['ratingClass']) &&
  typeof row['temperatureC'] === 'number' &&
  Number.isFinite(row['temperatureC']) &&
  isDim(row['bar']);

/** Errors of a raw `plant.catalog.ratingTables` value (absent is valid). */
function ratingTableErrors(raw: unknown): string[] {
  if (raw === undefined) return [];
  if (!isRecord(raw)) return ['plant.catalog.ratingTables must be an object'];
  const seen = new Set<string>();
  return Object.entries(raw).flatMap(([id, table]) => {
    const path = `plant.catalog.ratingTables.${id}`;
    if (!isRecord(table) || table['id'] !== id || typeof table['standard'] !== 'string' || typeof table['materialGroup'] !== 'string')
      return [`${path} must have id "${id}", standard and materialGroup`];
    if (id === BUNDLED_RATING_TABLE_ID) return [`${path}: the id is reserved for the bundled table`];
    const basis = squash(`${String(table['standard'])}|${String(table['materialGroup'])}`);
    const clash = seen.has(basis) ? [`${path} repeats the standard and material group of another table`] : [];
    seen.add(basis);
    const rows = table['rows'];
    const bad = !Array.isArray(rows) || rows.length === 0 || !rows.every(isRatingRow) || typeof table['minTemperatureC'] !== 'number';
    return [...clash, ...(bad ? [`${path} must have minTemperatureC and rows { ratingClass, temperatureC, bar }`] : [])];
  });
}

const isLibraryReference = (id: string, value: unknown): boolean =>
  isRecord(value) &&
  value['libraryId'] === id &&
  /^[A-Za-z0-9._-]{1,64}$/.test(id) &&
  typeof value['version'] === 'string' &&
  typeof value['sha256'] === 'string' &&
  /^[0-9a-f]{64}$/.test(value['sha256']);

/** Errors of a raw `plant.catalog.libraries` value (absent is valid). */
function libraryErrors(raw: unknown, catalogIds: readonly string[]): string[] {
  if (raw === undefined) return [];
  if (!isRecord(raw)) return ['plant.catalog.libraries must be an object'];
  return Object.entries(raw).flatMap(([id, value]) => [
    ...(isLibraryReference(id, value) ? [] : [`plant.catalog.libraries.${id} must be { libraryId: "${id}", version, sha256 (64 hex) }`]),
    ...(id === BUNDLED_CATALOG_ID || catalogIds.includes(id)
      ? [`plant.catalog.libraries.${id}: the id is already a bundled or imported catalogue`]
      : []),
  ]);
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
  return [
    ...orderErrors,
    ...ratingTableErrors(raw['ratingTables']),
    ...libraryErrors(raw['libraries'], ids),
    ...ids.flatMap((id) => catalogErrors(id, (raw['catalogs'] as Record<string, unknown>)[id])),
  ];
}

export const pipingCatalogDocument: DocumentExtension = {
  validate: (raw) => {
    const plant = raw['plant'];
    if (!isRecord(plant)) return [];
    return [
      ...(plant['catalog'] === undefined ? [] : pipingCatalogErrors(plant['catalog'])),
      ...(plant['spec'] === undefined ? [] : pipeSpecErrors(plant['spec'])),
    ];
  },
  derivedEntityIds: () => new Set<string>(),
  restore: (raw) => raw,
  // Replay starts from an empty slice: the approval ledger is kept so a recorded approve_pipe_spec step re-applies its (already verified) approval.
  replaySeed: (base) => {
    const approvals = base.plant?.spec?.approvals;
    return approvals === undefined || approvals.length === 0 ? {} : { plant: { spec: { specs: {}, specOrder: [], approvals } } };
  },
};
