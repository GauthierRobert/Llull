/**
 * CSV forms of the equipment data sheet (plant 03 EQP §6): `items` = every value of the record as one row (section, dotted item path, value, unit, source);
 * `nozzles` = the nozzle schedule, one row per nozzle. Text cells pass the spreadsheet formula guard of the 01 PSC sheets (an apostrophe before `= + - @`).
 * @invariant pure; row order = record order; numbers are written as numbers (never guarded)
 */

import { csvLines, type CsvCell } from '@lib/csv';
import { guardRows } from '../../catalog/csvGuard';
import type { Datasheet } from './record';
import type { Obj } from './millimetres';

const ITEM_COLUMNS = ['section', 'item', 'value', 'unit', 'source'] as const;
const NOZZLE_COLUMNS = [
  'mark',
  'portId',
  'service',
  'dn',
  'rating',
  'facing',
  'locationOn',
  'orientationDeg',
  'projectionMm',
  'positionXMm',
  'positionYMm',
  'positionZMm',
  'directionX',
  'directionY',
  'directionZ',
  'flangeOutsideDiameterMm',
  'flangeThicknessMm',
  'flangePlaceholder',
  'flangeUnverified',
  'flangeCatalogRef',
  'flangeSource',
] as const;

/** Keys whose unit is not a camelCase suffix (the exact names the composed queries use). */
const UNIT_OF_KEY: ReadonlyMap<string, string> = new Map([
  ['kg', 'kg'],
  ['mm', 'mm'],
  ['temperatureC', 'degC'],
  ['percent', '%'],
  ['H_m', 'm'],
  ['bottomM', 'm'],
  ['heightM', 'm'],
  ['diameterM', 'm'],
]);
/** Unit suffixes, anchored after a lowercase letter, digit or underscore so that `ratingC` or `dnMm2` style names never match: `emptyKg`, `totalVolumeM3`, `SE_MPa`. */
const UNIT_SUFFIX = /(?<=[a-z0-9_])(KgM3|Kg|M3|M2|Mm|MPa|Deg)$/;
const SUFFIX_UNIT: Readonly<Record<string, string>> = { KgM3: 'kg/m3', Kg: 'kg', M3: 'm3', M2: 'm2', Mm: 'mm', MPa: 'MPa', Deg: 'deg' };
const unitOfKey = (key: string): string | null => {
  const exact = UNIT_OF_KEY.get(key);
  if (exact !== undefined) return exact;
  const suffix = UNIT_SUFFIX.exec(key)?.[1];
  return suffix === undefined ? null : (SUFFIX_UNIT[suffix] ?? null);
};
/** The unit of the nearest key of `path` that has one (`headDepthsMm.first` and `boundingBoxMm.0` are millimetres). */
const unitOf = (path: string): string | null => {
  for (const key of path.split('.').reverse()) {
    const unit = unitOfKey(key);
    if (unit !== null) return unit;
  }
  return null;
};

const isScalar = (value: unknown): value is CsvCell => value === null || ['string', 'number', 'boolean'].includes(typeof value);
const isQuantity = (value: Obj): boolean => typeof value['unit'] === 'string' && 'value' in value && isScalar(value['value']);

function flatten(section: string, path: string, value: unknown, rows: CsvCell[][]): void {
  if (value === undefined) return;
  if (typeof value === 'number' && !Number.isFinite(value)) value = null;
  if (isScalar(value)) {
    rows.push([section, path, value, typeof value === 'number' ? unitOf(path) : null, null]);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => flatten(section, `${path}.${index}`, entry, rows));
    return;
  }
  const object = value as Obj;
  if (isQuantity(object)) {
    rows.push([
      section,
      path,
      object['value'] as CsvCell,
      object['unit'] as string,
      typeof object['source'] === 'string' ? object['source'] : null,
    ]);
    return;
  }
  for (const [key, entry] of Object.entries(object)) flatten(section, path === '' ? key : `${path}.${key}`, entry, rows);
}

export function itemsCsv(sheet: Datasheet): string {
  const rows: CsvCell[][] = [];
  const sections: Array<[string, unknown]> = [
    ['identification', sheet.identification],
    ['design', sheet.design],
    ['geometry', sheet.geometry],
    ['volumes', sheet.volumes],
    ['weights', sheet.weights],
    ['codeResults', sheet.codeResults],
    ['provenance', sheet.provenance],
    ['review', sheet.review],
    ['warnings', sheet.warnings],
  ];
  for (const [name, value] of sections) flatten(name, '', value, rows);
  return csvLines(ITEM_COLUMNS, guardRows(rows));
}

const at = (value: unknown, index: number): CsvCell => (Array.isArray(value) ? ((value[index] as CsvCell | undefined) ?? null) : null);
const cell = (value: unknown): CsvCell => (isScalar(value) ? value : null);

export function nozzlesCsv(sheet: Datasheet): string {
  const rows = sheet.nozzles.map((nozzle): CsvCell[] => {
    const flange = nozzle['flange'] as Obj;
    const location = nozzle['location'] as Obj;
    return [
      cell(nozzle['mark']),
      cell(nozzle['portId']),
      cell(nozzle['service']),
      cell(nozzle['dn']),
      cell(nozzle['rating']),
      cell(nozzle['facing']),
      cell(location['on']),
      cell(nozzle['orientationDeg']),
      cell(nozzle['projectionMm']),
      at(nozzle['positionMm'], 0),
      at(nozzle['positionMm'], 1),
      at(nozzle['positionMm'], 2),
      at(nozzle['direction'], 0),
      at(nozzle['direction'], 1),
      at(nozzle['direction'], 2),
      cell(flange['outsideDiameterMm']),
      cell(flange['thicknessMm']),
      cell(flange['placeholder']),
      cell(flange['unverified']),
      cell(flange['catalogRef']),
      cell(flange['source']),
    ];
  });
  return csvLines(NOZZLE_COLUMNS, guardRows(rows));
}
