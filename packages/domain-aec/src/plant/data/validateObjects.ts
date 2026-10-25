/** Load-time validation of the plant objects (plant 08 DAT §3): references, typed properties, tags unique per scope. A tag that drifted from its class format is a check_plant_data finding, not a load error. */

import { isRecord } from '@lib/isRecord';
import { resolveClass } from './classes';
import type { PlantDataModel, PlantObject } from './model';
import { coerceValue } from './properties';
import { duplicateTags, objectRegistry } from './registry';

export const isScalar = (value: unknown): boolean => value === null || ['string', 'number', 'boolean'].includes(typeof value);

/** `order` must list every key of `records` exactly once. */
export function orderErrors(order: unknown, records: Record<string, unknown>, path: string): string[] {
  if (!Array.isArray(order) || !order.every((entry) => typeof entry === 'string')) return [`${path} must be an array of ids`];
  const keys = Object.keys(records);
  const listed = new Set(order as string[]);
  return listed.size === order.length && order.length === keys.length && keys.every((key) => listed.has(key))
    ? []
    : [`${path} must list every entry once`];
}

function targetError(target: unknown, path: string): string | null {
  if (!isRecord(target)) return `${path}.target must be an object`;
  if (target['kind'] === 'reserved') return null;
  if (target['kind'] === 'buildingElement') return typeof target['id'] === 'string' ? null : `${path}.target.id must be a string`;
  if (target['kind'] === 'provider')
    return typeof target['provider'] === 'string' && typeof target['id'] === 'string' ? null : `${path}.target needs provider and id`;
  return `${path}.target.kind must be buildingElement, provider or reserved`;
}

function shapeErrors(key: string, object: Record<string, unknown>, data: PlantDataModel): string[] {
  const path = `plant.data.objects.${key}`;
  const errors: string[] = [];
  if (object['id'] !== key) errors.push(`${path}.id must equal its key`);
  if (typeof object['className'] !== 'string' || data.classes[object['className']] === undefined)
    errors.push(`${path}.className must name a class`);
  if (typeof object['hierarchyId'] !== 'string' || data.hierarchy[object['hierarchyId']] === undefined)
    errors.push(`${path}.hierarchyId must name a hierarchy node`);
  const target = targetError(object['target'], path);
  if (target !== null) errors.push(target);
  if (typeof object['tag'] !== 'string' || object['tag'].trim() === '') errors.push(`${path}.tag must be a non-empty string`);
  for (const field of ['tagFields', 'properties'])
    if (!isRecord(object[field]) || !Object.values(object[field]).every(isScalar))
      errors.push(`${path}.${field} must map names to text, numbers, booleans or null`);
  const provenance = object['provenance'];
  if (
    provenance !== undefined &&
    !(isRecord(provenance) && Object.values(provenance).every((entry) => isRecord(entry) && typeof entry['source'] === 'string'))
  )
    errors.push(`${path}.provenance must map property names to { source, ref?, unverified? }`);
  if (object['lineId'] !== undefined && (typeof object['lineId'] !== 'string' || data.objects[object['lineId']] === undefined))
    errors.push(`${path}.lineId must name a plant object`);
  return errors;
}

function semanticErrors(key: string, object: PlantObject, data: PlantDataModel): string[] {
  const path = `plant.data.objects.${key}`;
  const resolution = resolveClass(data, object.className);
  if (!resolution.ok) return [`${path}.className: ${resolution.message}`];
  if (resolution.resolved.abstract) return [`${path}.className ${object.className} is abstract`];
  const errors: string[] = [];
  for (const [name, value] of Object.entries(object.properties)) {
    const definition = resolution.resolved.properties.find((candidate) => candidate.name === name);
    if (definition === undefined) errors.push(`${path}.properties.${name} is not a property of ${object.className}`);
    else {
      const checked = coerceValue(definition, value);
      if (!checked.ok) errors.push(`${path}.properties.${name}: ${checked.message}`);
    }
  }
  return errors;
}

export function objectErrors(raw: Record<string, unknown>, data: PlantDataModel): string[] {
  const objects = raw['objects'];
  if (!isRecord(objects)) return ['plant.data.objects must be an object'];
  const errors = [
    ...Object.entries(objects).flatMap(([key, object]) =>
      isRecord(object) ? shapeErrors(key, object, data) : [`plant.data.objects.${key} must be an object`],
    ),
    ...orderErrors(raw['objectOrder'], objects, 'plant.data.objectOrder'),
  ];
  if (errors.length > 0) return errors;
  for (const [key, object] of Object.entries(data.objects)) errors.push(...semanticErrors(key, object, data));
  if (errors.length > 0) return errors;
  for (const { tag, ids } of duplicateTags(data, objectRegistry(data)))
    errors.push(`plant.data: tag "${tag}" is held by ${ids.join(', ')} in colliding tag scopes`);
  return errors;
}
