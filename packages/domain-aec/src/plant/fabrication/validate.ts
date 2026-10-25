/** Load-time validation of `plant.fabrication` (the plugin's `DocumentExtension.validate`, plant 05 ISO §6.2). */

import { isRecord } from '@lib/isRecord';
import { isPcfComponentType } from './model';

const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const isVec3 = (value: unknown): boolean => Array.isArray(value) && value.length === 3 && value.every(isFiniteNumber);
const isStringRecord = (value: unknown): boolean => isRecord(value) && Object.values(value).every((entry) => typeof entry === 'string');

function pointError(value: unknown, path: string): string[] {
  if (!isRecord(value)) return [`${path} must be an object`];
  return [
    ...(isVec3(value['xyz']) ? [] : [`${path}.xyz must be three finite numbers`]),
    ...(isFiniteNumber(value['boreMm']) ? [] : [`${path}.boreMm must be a finite number`]),
    ...(value['endType'] === undefined || typeof value['endType'] === 'string' ? [] : [`${path}.endType must be a string`]),
  ];
}

function componentErrors(value: unknown, path: string, ids: Set<string>): string[] {
  if (!isRecord(value)) return [`${path} must be an object`];
  const errors: string[] = [];
  if (typeof value['id'] !== 'string' || value['id'] === '') errors.push(`${path}.id must be a non-empty string`);
  else if (ids.has(value['id'])) errors.push(`${path}.id ${value['id']} is used twice`);
  else ids.add(value['id']);
  if (typeof value['type'] !== 'string' || !isPcfComponentType(value['type'])) errors.push(`${path}.type is not a PCF component type`);
  const ends = value['ends'];
  if (!Array.isArray(ends) || ends.length > 2) errors.push(`${path}.ends must be an array of at most two points`);
  else ends.forEach((end, index) => errors.push(...pointError(end, `${path}.ends[${index}]`)));
  if (value['branch'] !== undefined) errors.push(...pointError(value['branch'], `${path}.branch`));
  for (const key of ['centre', 'coords'])
    if (value[key] !== undefined && !isVec3(value[key])) errors.push(`${path}.${key} must be three finite numbers`);
  for (const key of ['skey', 'itemCode', 'description'])
    if (value[key] !== undefined && typeof value[key] !== 'string') errors.push(`${path}.${key} must be a string`);
  if (value['weight'] !== undefined && !isFiniteNumber(value['weight'])) errors.push(`${path}.weight must be a finite number`);
  if (value['category'] !== undefined && !['fabrication', 'erection', 'offshore'].includes(String(value['category'])))
    errors.push(`${path}.category must be fabrication, erection or offshore`);
  if (value['weldKind'] !== undefined && !['shop', 'site', 'field_fit'].includes(String(value['weldKind'])))
    errors.push(`${path}.weldKind must be shop, site or field_fit`);
  for (const key of ['derived', 'unverified'])
    if (value[key] !== undefined && value[key] !== true) errors.push(`${path}.${key} must be true when present`);
  if (value['extra'] !== undefined && !isStringRecord(value['extra'])) errors.push(`${path}.extra must map strings to strings`);
  return errors;
}

function lineErrors(key: string, value: unknown): string[] {
  const path = `plant.fabrication.pcfLines.${key}`;
  if (!isRecord(value)) return [`${path} must be an object`];
  const errors: string[] = [];
  if (value['lineId'] !== key) errors.push(`${path}.lineId must equal its key`);
  if (!isStringRecord(value['header'])) errors.push(`${path}.header must map strings to strings`);
  const units = value['units'];
  if (!isRecord(units) || !['MM', 'INCH'].includes(String(units['bore'])) || !['MM', 'INCH'].includes(String(units['coords'])))
    errors.push(`${path}.units must declare bore and coords as MM or INCH`);
  else
    for (const key of ['boltDia', 'boltLength'])
      if (units[key] !== undefined && !['MM', 'INCH'].includes(String(units[key]))) errors.push(`${path}.units.${key} must be MM or INCH`);
  if (!isStringRecord(value['attributes'])) errors.push(`${path}.attributes must map strings to strings`);
  const ids = new Set<string>();
  if (!Array.isArray(value['components'])) errors.push(`${path}.components must be an array`);
  else value['components'].forEach((component, index) => errors.push(...componentErrors(component, `${path}.components[${index}]`, ids)));
  const materials = value['materials'];
  if (!Array.isArray(materials)) errors.push(`${path}.materials must be an array`);
  else
    materials.forEach((material, index) => {
      if (!isRecord(material) || typeof material['itemCode'] !== 'string' || !isStringRecord(material['fields']))
        errors.push(`${path}.materials[${index}] must be { itemCode, fields }`);
    });
  const unknown = value['unknownRecords'];
  if (!Array.isArray(unknown)) errors.push(`${path}.unknownRecords must be an array`);
  else
    unknown.forEach((record, index) => {
      if (
        !isRecord(record) ||
        typeof record['type'] !== 'string' ||
        !Number.isInteger(record['line']) ||
        !Number.isInteger(record['after']) ||
        !Array.isArray(record['text']) ||
        !record['text'].every((line) => typeof line === 'string')
      )
        errors.push(`${path}.unknownRecords[${index}] must be { type, line, after, text[] }`);
    });
  return errors;
}

/** Problems of a raw `plant.fabrication` (empty = valid or absent). */
export function fabricationErrors(raw: unknown): string[] {
  if (raw === undefined) return [];
  if (!isRecord(raw)) return ['plant.fabrication must be an object'];
  if (raw['version'] !== 1) return ['plant.fabrication.version must be 1'];
  const lines = raw['pcfLines'];
  if (!isRecord(lines)) return ['plant.fabrication.pcfLines must be an object'];
  return Object.entries(lines).flatMap(([key, value]) => lineErrors(key, value));
}
