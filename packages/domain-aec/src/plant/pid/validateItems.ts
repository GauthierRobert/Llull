/**
 * Load-time validation of the items of `plant.pid` (plant 04 PID §6.4): shape of every item kind, then the references between items. A file that
 * breaks one is refused with the path. Tag uniqueness is NOT a load error (imported data may repeat a tag: `check_pid` reports PID_TAG_DUPLICATE).
 */

import { isRecord } from '@lib/isRecord';
import { isReservedKey } from '@lib/reservedKey';
import {
  PID_ACTUATORS,
  PID_FAIL_ACTIONS,
  PID_INSTRUMENT_DISPLAYS,
  PID_INSTRUMENT_LOCATIONS,
  PID_ITEM_KINDS,
  PID_SIGNAL_KINDS,
} from './model';

const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const isVec2 = (value: unknown): boolean => Array.isArray(value) && value.length === 2 && value.every(isFiniteNumber);
const isRoute = (value: unknown): boolean => Array.isArray(value) && value.length >= 2 && value.every(isVec2);
const isOneOf = (list: readonly string[], value: unknown): boolean => typeof value === 'string' && list.includes(value);
const isStringRecord = (value: unknown): boolean => isRecord(value) && Object.values(value).every((entry) => typeof entry === 'string');

type Items = Record<string, unknown>;

/** The kind of item `id` names in `items`, or undefined. */
const kindOf = (items: Items, id: unknown): string | undefined => {
  const item = typeof id === 'string' && Object.hasOwn(items, id) ? items[id] : undefined;
  return isRecord(item) && typeof item['kind'] === 'string' ? item['kind'] : undefined;
};

function valueErrors(value: unknown, path: string): string[] {
  if (!isRecord(value)) return [`${path} must be an object`];
  const flags = ['defaulted', 'unverified'].filter((flag) => value[flag] !== undefined && value[flag] !== true);
  const errors = flags.map((flag) => `${path}.${flag} must be true when present`);
  if (value['kind'] === 'text') {
    if (typeof value['value'] !== 'string') errors.push(`${path}.value must be a string`);
  } else if (value['kind'] === 'quantity') {
    if (!isFiniteNumber(value['value'])) errors.push(`${path}.value must be a finite number`);
    if (typeof value['unit'] !== 'string' || value['unit'] === '') errors.push(`${path}.unit must be a non-empty string`);
  } else if (value['kind'] === 'enum') {
    if (typeof value['value'] !== 'string') errors.push(`${path}.value must be a string`);
    if (value['uri'] !== undefined && typeof value['uri'] !== 'string') errors.push(`${path}.uri must be a string`);
  } else errors.push(`${path}.kind must be text, quantity or enum`);
  return errors;
}

function endpointErrors(value: unknown, path: string, items: Items): string[] {
  if (!isRecord(value)) return [`${path} must be an object`];
  const itemRef = (kinds: readonly string[]): string[] => {
    const kind = kindOf(items, value['itemId']);
    return kind !== undefined && kinds.includes(kind) ? [] : [`${path}.itemId must name an item of kind ${kinds.join(' or ')}`];
  };
  switch (value['type']) {
    case 'nozzle':
      return itemRef(['nozzle']);
    case 'opc':
      return itemRef(['opc']);
    case 'instrument':
      return itemRef(['instrument', 'actuating']);
    case 'inline': {
      const errors = itemRef(['inline']);
      const item = items[String(value['itemId'])];
      const ports = isRecord(item) && Array.isArray(item['ports']) ? item['ports'].length : 0;
      const node = value['node'];
      if (errors.length === 0 && !(Number.isInteger(node) && (node as number) >= 0 && (node as number) < ports))
        errors.push(`${path}.node must be a port index of the inline item (0..${ports - 1})`);
      return errors;
    }
    case 'branch':
      return [
        ...(kindOf(items, value['segmentId']) === 'segment' ? [] : [`${path}.segmentId must name a segment`]),
        ...(isVec2(value['at']) ? [] : [`${path}.at must be two finite numbers`]),
      ];
    case 'free':
      return isVec2(value['at']) ? [] : [`${path}.at must be two finite numbers`];
    default:
      return [`${path}.type must be nozzle, inline, branch, opc, free or instrument`];
  }
}

function kindErrors(item: Record<string, unknown>, path: string, items: Items, sheets: Record<string, unknown>): string[] {
  const reference = (field: string, kinds: readonly string[], optional = false): string[] => {
    if (optional && item[field] === undefined) return [];
    const kind = kindOf(items, item[field]);
    return kind !== undefined && kinds.includes(kind) ? [] : [`${path}.${field} must name an item of kind ${kinds.join(' or ')}`];
  };
  const optionalDn =
    item['dn'] === undefined || (Number.isInteger(item['dn']) && (item['dn'] as number) > 0)
      ? []
      : [`${path}.dn must be a positive integer`];
  const optionalText = (fields: readonly string[]): string[] =>
    fields
      .filter((field) => item[field] !== undefined && typeof item[field] !== 'string')
      .map((field) => `${path}.${field} must be a string`);
  switch (item['kind']) {
    case 'equipment':
      return reference('parentId', ['equipment'], true);
    case 'nozzle':
      return [
        ...reference('equipmentId', ['equipment']),
        ...(typeof item['subTag'] === 'string' && item['subTag'] !== '' ? [] : [`${path}.subTag must be a non-empty string`]),
        ...optionalDn,
        ...(item['access'] === undefined || typeof item['access'] === 'boolean' ? [] : [`${path}.access must be a boolean`]),
        ...(isVec2(item['port']) ? [] : [`${path}.port must be two finite numbers`]),
      ];
    case 'line': {
      const ids = item['segmentIds'];
      if (!Array.isArray(ids)) return [`${path}.segmentIds must be an array`];
      return [
        ...optionalDn,
        ...optionalText(['lineNumber', 'pipingClass', 'fluidCode']),
        ...ids.flatMap((id, index) => {
          if (kindOf(items, id) !== 'segment') return [`${path}.segmentIds[${index}] must name a segment`];
          const owner = (items[String(id)] as Record<string, unknown>)['lineId'];
          return owner === item['id'] ? [] : [`${path}.segmentIds[${index}] belongs to another line`];
        }),
      ];
    }
    case 'segment':
      return [
        ...reference('lineId', ['line']),
        ...endpointErrors(item['from'], `${path}.from`, items),
        ...endpointErrors(item['to'], `${path}.to`, items),
        ...(isRoute(item['route']) ? [] : [`${path}.route must be at least two points of two finite numbers`]),
        ...(isOneOf(['forward', 'reverse', 'none'], item['flow']) ? [] : [`${path}.flow must be forward, reverse or none`]),
        ...(typeof item['primary'] === 'boolean' ? [] : [`${path}.primary must be a boolean`]),
        ...optionalDn,
        ...optionalText(['pipingClass']),
      ];
    case 'inline':
      return [
        ...(Array.isArray(item['ports']) && item['ports'].every(isVec2) ? [] : [`${path}.ports must be an array of points`]),
        ...optionalDn,
        ...optionalText(['pipingClass']),
        ...['reversed', 'operated']
          .filter((f) => item[f] !== undefined && typeof item[f] !== 'boolean')
          .map((f) => `${path}.${f} must be a boolean`),
      ];
    case 'instrument':
      return [
        ...['category', 'functions', 'loopNumber'].filter((f) => typeof item[f] !== 'string').map((f) => `${path}.${f} must be a string`),
        ...(isOneOf(PID_INSTRUMENT_LOCATIONS, item['location']) ? [] : [`${path}.location must be ${PID_INSTRUMENT_LOCATIONS.join(', ')}`]),
        ...(isOneOf(PID_INSTRUMENT_DISPLAYS, item['display']) ? [] : [`${path}.display must be ${PID_INSTRUMENT_DISPLAYS.join(', ')}`]),
        ...reference('loopId', ['loop'], true),
      ];
    case 'signal':
      return [
        ...(isOneOf(PID_SIGNAL_KINDS, item['signalKind']) ? [] : [`${path}.signalKind must be ${PID_SIGNAL_KINDS.join(', ')}`]),
        ...endpointErrors(item['from'], `${path}.from`, items),
        ...endpointErrors(item['to'], `${path}.to`, items),
        ...(isRoute(item['route']) ? [] : [`${path}.route must be at least two points of two finite numbers`]),
      ];
    case 'actuating':
      return [
        ...reference('valveId', ['inline']),
        ...(isOneOf(PID_ACTUATORS, item['actuator']) ? [] : [`${path}.actuator must be ${PID_ACTUATORS.join(', ')}`]),
        ...(item['failAction'] === undefined || isOneOf(PID_FAIL_ACTIONS, item['failAction'])
          ? []
          : [`${path}.failAction must be ${PID_FAIL_ACTIONS.join(', ')}`]),
        ...reference('controllerId', ['instrument'], true),
      ];
    case 'opc':
      return [
        ...(isOneOf(['in', 'out'], item['direction']) ? [] : [`${path}.direction must be in or out`]),
        ...(typeof item['pairKey'] === 'string' && item['pairKey'] !== '' ? [] : [`${path}.pairKey must be a non-empty string`]),
        ...(item['targetSheet'] === undefined || (typeof item['targetSheet'] === 'string' && Object.hasOwn(sheets, item['targetSheet']))
          ? []
          : [`${path}.targetSheet must name a sheet`]),
      ];
    default:
      return [];
  }
}

function baseErrors(item: Record<string, unknown>, path: string, sheets: Record<string, unknown>): string[] {
  const errors: string[] = [];
  if (!isOneOf(PID_ITEM_KINDS, item['kind'])) errors.push(`${path}.kind must be one of ${PID_ITEM_KINDS.join(', ')}`);
  if (typeof item['sheetId'] !== 'string' || !Object.hasOwn(sheets, item['sheetId'])) errors.push(`${path}.sheetId must name a sheet`);
  if (!isVec2(item['at'])) errors.push(`${path}.at must be two finite numbers`);
  if (!isFiniteNumber(item['rotationDeg'])) errors.push(`${path}.rotationDeg must be a finite number`);
  if (typeof item['dexpiClass'] !== 'string' || item['dexpiClass'] === '') errors.push(`${path}.dexpiClass must be a non-empty string`);
  for (const field of ['classUri', 'tag', 'sourceId'])
    if (item[field] !== undefined && typeof item[field] !== 'string') errors.push(`${path}.${field} must be a string`);
  if (!isRecord(item['attributes'])) errors.push(`${path}.attributes must be an object`);
  else for (const [name, value] of Object.entries(item['attributes'])) errors.push(...valueErrors(value, `${path}.attributes.${name}`));
  if (item['passthrough'] !== undefined && !isStringRecord(item['passthrough']))
    errors.push(`${path}.passthrough must map strings to strings`);
  return errors;
}

/** Sub-equipment must form a forest: following parentId never returns to the start. */
function parentCycleErrors(items: Items): string[] {
  const parentOf = (id: string): string | undefined => {
    const item = items[id];
    return isRecord(item) && item['kind'] === 'equipment' && typeof item['parentId'] === 'string' ? item['parentId'] : undefined;
  };
  const errors: string[] = [];
  const done = new Set<string>();
  for (const start of Object.keys(items)) {
    const chain = new Set<string>();
    for (let current: string | undefined = start; current !== undefined && !done.has(current); current = parentOf(current)) {
      if (chain.has(current)) {
        errors.push(`plant.pid.items.${current}.parentId: the sub-equipment chain returns to the item itself`);
        break;
      }
      chain.add(current);
    }
    for (const id of chain) done.add(id);
  }
  return errors;
}

/** Errors of `plant.pid.items` / `itemOrder`; `sheets` = the (already validated) sheet record. */
export function itemErrors(raw: Record<string, unknown>, sheets: Record<string, unknown>): string[] {
  const items = raw['items'];
  if (!isRecord(items)) return ['plant.pid.items must be an object'];
  const errors: string[] = [];
  const order = raw['itemOrder'];
  const keys = Object.keys(items);
  if (
    !Array.isArray(order) ||
    order.length !== keys.length ||
    !order.every((id) => typeof id === 'string' && Object.hasOwn(items, id)) ||
    new Set(order).size !== keys.length
  )
    errors.push('plant.pid.itemOrder must list every item id exactly once');
  for (const key of keys) {
    const path = `plant.pid.items.${key}`;
    const item = items[key];
    if (isReservedKey(key)) {
      errors.push(`${path}: the id is a reserved name`);
      continue;
    }
    if (!isRecord(item)) {
      errors.push(`${path} must be an object`);
      continue;
    }
    if (item['id'] !== key) errors.push(`${path}.id must equal its key`);
    const shape = baseErrors(item, path, sheets);
    errors.push(...shape);
    if (shape.length === 0) errors.push(...kindErrors(item, path, items, sheets));
  }
  errors.push(...parentCycleErrors(items));
  return errors;
}
