/**
 * Structural validation of a loaded building model (persistence boundary).
 * @layer core/commands/building
 * @pure
 */

import { isRecord } from '../../../lib/isRecord';

const CATEGORIES: ReadonlySet<string> = new Set([
  'grid',
  'wall',
  'door',
  'window',
  'slab',
  'column',
  'beam',
  'stair',
  'room',
]);

/** Numeric fields each category must carry (finite numbers). */
const NUMBERS: Readonly<Record<string, ReadonlyArray<string>>> = {
  grid: [],
  wall: ['thickness', 'height', 'baseOffset'],
  door: ['offset', 'width', 'height', 'sillHeight'],
  window: ['offset', 'width', 'height', 'sillHeight'],
  slab: ['thickness', 'offset'],
  column: ['width', 'depth', 'height'],
  beam: ['width', 'depth', 'topOffset'],
  stair: ['angle', 'width', 'riserCount', 'riserHeight', 'treadDepth'],
  room: [],
};

/** Plan-point fields each category must carry. */
const POINTS: Readonly<Record<string, ReadonlyArray<string>>> = {
  grid: ['start', 'end'],
  wall: ['start', 'end'],
  door: [],
  window: [],
  slab: [],
  column: ['location'],
  beam: ['start', 'end'],
  stair: ['start'],
  room: [],
};

const isPoint = (value: unknown): boolean =>
  Array.isArray(value) &&
  value.length >= 2 &&
  value.every((n) => typeof n === 'number' && Number.isFinite(n));

const isPolygon = (value: unknown): boolean =>
  Array.isArray(value) && value.length >= 3 && value.every(isPoint);

const isStringArray = (value: unknown): boolean =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');

function elementErrors(key: string, element: unknown, levels: Record<string, unknown>): string[] {
  if (!isRecord(element)) return [`building element ${key} is not an object`];
  const category = element['category'];
  if (typeof category !== 'string' || !CATEGORIES.has(category)) {
    return [`building element ${key}: unknown category '${String(category)}'`];
  }
  const errors: string[] = [];
  if (element['id'] !== key) errors.push(`building element ${key}: id does not match its key`);
  if (typeof element['mark'] !== 'string')
    errors.push(`building element ${key}: mark must be a string`);
  if (!isStringArray(element['entityIds']))
    errors.push(`building element ${key}: entityIds must be a string array`);
  for (const field of NUMBERS[category] ?? []) {
    const value = element[field];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      errors.push(`building element ${key}: ${field} must be a finite number`);
    }
  }
  for (const field of POINTS[category] ?? []) {
    if (!isPoint(element[field])) errors.push(`building element ${key}: ${field} must be [x, y]`);
  }
  if ((category === 'slab' || category === 'room') && !isPolygon(element['boundary'])) {
    errors.push(`building element ${key}: boundary must be a polygon of ≥ 3 [x, y] points`);
  }
  if (category === 'slab' && element['openings'] !== undefined) {
    const openings = element['openings'];
    if (!Array.isArray(openings) || !openings.every(isPolygon)) {
      errors.push(`building element ${key}: openings must be polygons`);
    }
  }
  if (category !== 'grid' && category !== 'door' && category !== 'window') {
    const levelId = element['levelId'];
    if (typeof levelId !== 'string' || !(levelId in levels)) {
      errors.push(`building element ${key}: levelId '${String(levelId)}' is not a known level`);
    }
  }
  if ((category === 'door' || category === 'window') && typeof element['hostId'] !== 'string') {
    errors.push(`building element ${key}: hostId must be a string`);
  }
  return errors;
}

/** Errors describing why `raw` is not a usable BuildingModel (empty when valid). */
export function buildingErrors(raw: unknown): string[] {
  if (!isRecord(raw)) return ['building must be an object'];
  const errors: string[] = [];
  const levels = raw['levels'];
  const elements = raw['elements'];
  if (!isRecord(raw['project'])) errors.push('building.project must be an object');
  if (!isRecord(levels)) return [...errors, 'building.levels must be an object'];
  if (!isRecord(elements)) return [...errors, 'building.elements must be an object'];
  for (const [key, level] of Object.entries(levels)) {
    const valid =
      isRecord(level) &&
      level['id'] === key &&
      typeof level['name'] === 'string' &&
      typeof level['elevation'] === 'number' &&
      Number.isFinite(level['elevation']) &&
      typeof level['height'] === 'number' &&
      level['height'] > 0;
    if (!valid) errors.push(`building level ${key} is malformed (id, name, elevation, height > 0)`);
  }
  for (const [field, table] of [
    ['levelOrder', levels],
    ['elementOrder', elements],
  ] as const) {
    const order = raw[field];
    if (!isStringArray(order) || !(order as string[]).every((id) => id in table)) {
      errors.push(`building.${field} must list known ids`);
    }
  }
  for (const [key, element] of Object.entries(elements))
    errors.push(...elementErrors(key, element, levels));
  return errors;
}
