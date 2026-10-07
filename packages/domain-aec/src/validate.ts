/**
 * Structural validation of a loaded building model (persistence boundary).
 * @layer domain-aec
 * @pure
 */

import { isFiniteNumber, isPositiveNumber } from '@lib/isFiniteNumber';
import { isRecord } from '@lib/isRecord';
import { MEMBER_LAYER } from './entities';
import { arcThrough } from './curvedWallGeometry';
import { parseWallLayers } from './wallLayers';
import { isVec2 } from './model';
import { EQUIPMENT_SHAPES } from './industrial/equipmentShape';

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
  member: ['roll'],
  footing: ['width', 'length', 'thickness', 'topOffset'],
  panel: ['thickness'],
  equipment: ['angle', 'clearance', 'weight'],
  pipe: ['diameter'],
  tray: ['width', 'height'],
  plate: ['length', 'width', 'thickness', 'boltCount', 'boltDiameter'],
  curvedWall: ['thickness', 'height', 'baseOffset'],
  connection: ['plateThickness', 'boltRows', 'boltDiameter', 'haunchLength'],
  pipeSupport: ['rodLength', 'pedestalHeight'],
};

const CATEGORIES: ReadonlySet<string> = new Set(Object.keys(NUMBERS));

/** Fields that must be strictly positive. */
const POSITIVE: Readonly<Record<string, ReadonlyArray<string>>> = {
  wall: ['thickness', 'height'],
  door: ['width', 'height'],
  window: ['width', 'height'],
  slab: ['thickness'],
  column: ['width', 'depth', 'height'],
  beam: ['width', 'depth'],
  stair: ['width', 'riserHeight', 'treadDepth'],
  footing: ['width', 'length', 'thickness'],
  panel: ['thickness'],
  pipe: ['diameter'],
  tray: ['width', 'height'],
  plate: ['length', 'width', 'thickness', 'boltCount', 'boltDiameter'],
  curvedWall: ['thickness', 'height'],
  connection: ['plateThickness', 'boltRows', 'boltDiameter'],
};

/** Plan-point fields each category must carry (categories not listed carry none). */
const POINTS: Readonly<Record<string, ReadonlyArray<string>>> = {
  grid: ['start', 'end'],
  wall: ['start', 'end'],
  column: ['location'],
  beam: ['start', 'end'],
  stair: ['start'],
  footing: ['location'],
  equipment: ['location'],
  curvedWall: ['start', 'through', 'end'],
};

const isPoint = (value: unknown): boolean =>
  Array.isArray(value) && value.length >= 2 && value.every(isFiniteNumber);

const isPoint3 = (value: unknown): boolean =>
  Array.isArray(value) && value.length === 3 && value.every(isFiniteNumber);

const isPolygon = (value: unknown): boolean =>
  Array.isArray(value) && value.length >= 3 && value.every(isPoint);

const isStringArray = (value: unknown): boolean =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');

type Elements = Record<string, unknown>;

function wallLayerErrors(key: string, element: Elements): string[] {
  const raw = element['layers'];
  if (raw === undefined) return [];
  const layers = parseWallLayers(raw);
  const thickness = element['thickness'];
  if (typeof layers === 'string') return [`building element ${key}: ${layers}`];
  if (
    !(raw as unknown[]).every((layer) => isRecord(layer) && typeof layer['function'] === 'string')
  ) {
    return [`building element ${key}: every stored layer needs a function`];
  }
  const total = layers.reduce((sum, layer) => sum + layer.thickness, 0);
  return typeof thickness === 'number' &&
    Math.abs(total - thickness) > 1e-6 * Math.max(1, thickness)
    ? [`building element ${key}: layer thicknesses must add up to the wall thickness`]
    : [];
}

function connectionErrors(key: string, element: Elements, elements: Elements): string[] {
  const errors: string[] = [];
  for (const field of ['rafterId', 'otherId']) {
    const id = element[field];
    const member = typeof id === 'string' ? elements[id] : undefined;
    if (!isRecord(member) || member['category'] !== 'member') {
      errors.push(`building element ${key}: ${field} '${String(id)}' is not a steel member`);
    }
  }
  if (element['kind'] !== 'eaves' && element['kind'] !== 'apex') {
    errors.push(`building element ${key}: kind must be eaves or apex`);
  }
  if (element['end'] !== 'start' && element['end'] !== 'end') {
    errors.push(`building element ${key}: end must be start or end`);
  }
  return errors;
}

function plateErrors(key: string, element: Elements, elements: Elements): string[] {
  const errors: string[] = [];
  const memberId = element['memberId'];
  const host = typeof memberId === 'string' ? elements[memberId] : undefined;
  if (!isRecord(host) || host['category'] !== 'member' || host['role'] !== 'column') {
    errors.push(`building element ${key}: memberId '${String(memberId)}' is not a steel column`);
  }
  const bolts = element['boltCount'];
  if (!(typeof bolts === 'number' && Number.isInteger(bolts) && bolts % 2 === 0)) {
    errors.push(`building element ${key}: boltCount must be an even integer`);
  }
  const fixity = element['fixity'];
  if (fixity !== undefined && fixity !== 'pinned' && fixity !== 'fixed') {
    errors.push(`building element ${key}: fixity must be pinned or fixed`);
  }
  return errors;
}

function pipeSupportErrors(key: string, element: Elements, elements: Elements): string[] {
  const errors: string[] = [];
  const pipeId = element['pipeId'];
  const pipe = typeof pipeId === 'string' ? elements[pipeId] : undefined;
  if (!isRecord(pipe) || pipe['category'] !== 'pipe') {
    errors.push(`building element ${key}: pipeId '${String(pipeId)}' is not a pipe`);
  }
  if (!['shoe', 'hanger', 'guide', 'anchor'].includes(String(element['type']))) {
    errors.push(`building element ${key}: type must be shoe, hanger, guide or anchor`);
  }
  if (!isPoint3(element['position'])) {
    errors.push(`building element ${key}: position must be [x, y, z]`);
  }
  const memberId = element['memberId'];
  if (memberId !== null && typeof memberId !== 'string') {
    errors.push(`building element ${key}: memberId must be a steel member id or null`);
  }
  for (const field of ['rodLength', 'pedestalHeight', 'standoff']) {
    const value = element[field];
    if (typeof value === 'number' && value < 0) {
      errors.push(`building element ${key}: ${field} must be >= 0`);
    }
  }
  const angle = element['standoffAngle'];
  if (angle !== undefined && !isFiniteNumber(angle)) {
    errors.push(`building element ${key}: standoffAngle must be a finite number`);
  }
  return errors;
}

function openingHostErrors(key: string, element: Elements, elements: Elements): string[] {
  const hostId = element['hostId'];
  if (typeof hostId !== 'string') return [`building element ${key}: hostId must be a string`];
  const host = elements[hostId];
  return isRecord(host) && (host['category'] === 'wall' || host['category'] === 'curvedWall')
    ? []
    : [`building element ${key}: hostId '${hostId}' is not a wall`];
}

function elementErrors(
  key: string,
  element: unknown,
  levels: Record<string, unknown>,
  elements: Record<string, unknown>,
): string[] {
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
    if (!isFiniteNumber(value)) {
      errors.push(`building element ${key}: ${field} must be a finite number`);
    }
  }
  for (const field of POSITIVE[category] ?? []) {
    const value = element[field];
    if (typeof value === 'number' && !(value > 0))
      errors.push(`building element ${key}: ${field} must be > 0`);
  }
  for (const field of ['sillHeight', 'clearance', 'weight']) {
    const value = element[field];
    if (typeof value === 'number' && value < 0)
      errors.push(`building element ${key}: ${field} must be >= 0`);
  }
  const reinforcement = element['reinforcement'];
  if (category === 'footing' && reinforcement !== undefined) {
    const valid =
      isRecord(reinforcement) &&
      ['barDiameter', 'spacing', 'cover'].every((field) => {
        const value = reinforcement[field];
        return isPositiveNumber(value);
      });
    if (!valid) {
      errors.push(
        `building element ${key}: reinforcement must have barDiameter, spacing and cover > 0`,
      );
    }
  }
  if (category === 'stair') {
    const risers = element['riserCount'];
    if (!(typeof risers === 'number' && Number.isInteger(risers) && risers >= 1)) {
      errors.push(`building element ${key}: riserCount must be an integer >= 1`);
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
  if (category === 'member' && (!isPoint3(element['start']) || !isPoint3(element['end']))) {
    errors.push(`building element ${key}: start and end must be [x, y, z]`);
  }
  if (category === 'member' && typeof element['profile'] !== 'string') {
    errors.push(`building element ${key}: profile must be a string`);
  }
  if (category === 'member') {
    const allowed: Readonly<Record<string, ReadonlyArray<string>>> = {
      startJoint: ['pinned', 'rigid'],
      endJoint: ['pinned', 'rigid'],
      baseFixity: ['pinned', 'fixed'],
    };
    for (const [field, values] of Object.entries(allowed)) {
      const value = element[field];
      if (value !== undefined && !(typeof value === 'string' && values.includes(value))) {
        errors.push(`building element ${key}: ${field} must be ${values.join(' or ')}`);
      }
    }
  }
  if (
    category === 'equipment' &&
    !(isPoint3(element['size']) && (element['size'] as number[]).every((n) => n > 0))
  ) {
    errors.push(`building element ${key}: size must be [length, width, height], all > 0`);
  }
  const shapeValue = element['shape'];
  if (
    category === 'equipment' &&
    shapeValue !== undefined &&
    !(typeof shapeValue === 'string' && EQUIPMENT_SHAPES.includes(shapeValue))
  ) {
    errors.push(`building element ${key}: shape must be one of ${EQUIPMENT_SHAPES.join(', ')}`);
  }
  const role = element['role'];
  if (
    category === 'member' &&
    !(typeof role === 'string' && Object.keys(MEMBER_LAYER).includes(role))
  ) {
    errors.push(
      `building element ${key}: role must be one of ${Object.keys(MEMBER_LAYER).join(', ')}`,
    );
  }
  if (category === 'panel' && role !== 'roof' && role !== 'wall') {
    errors.push(`building element ${key}: role must be roof or wall`);
  }
  const textFields: Partial<Record<string, ReadonlyArray<string>>> = {
    member: ['material'],
    footing: ['material'],
    panel: ['material'],
    equipment: ['name'],
    pipe: ['service', 'material'],
    tray: ['system'],
    plate: ['material'],
    curvedWall: ['material'],
    connection: ['material'],
  };
  for (const field of textFields[category] ?? []) {
    if (typeof element[field] !== 'string') {
      errors.push(`building element ${key}: ${field} must be a string`);
    }
  }
  if (category === 'pipe') {
    for (const field of ['line', 'from', 'to']) {
      if (element[field] !== undefined && typeof element[field] !== 'string') {
        errors.push(`building element ${key}: ${field} must be a string`);
      }
    }
    const dn = element['dn'];
    if (dn !== undefined && !(typeof dn === 'number' && Number.isInteger(dn) && dn > 0)) {
      errors.push(`building element ${key}: dn must be a positive integer`);
    }
  }
  for (const [field, minimum] of [
    ['corners', 3],
    ['points', 2],
  ] as const) {
    const expected =
      (category === 'panel' && field === 'corners') ||
      ((category === 'pipe' || category === 'tray') && field === 'points');
    const value = element[field];
    if (expected && !(Array.isArray(value) && value.length >= minimum && value.every(isPoint3))) {
      errors.push(`building element ${key}: ${field} must be ≥ ${minimum} [x, y, z] points`);
    }
  }
  if (category !== 'grid' && category !== 'door' && category !== 'window') {
    const levelId = element['levelId'];
    if (typeof levelId !== 'string' || !(levelId in levels)) {
      errors.push(`building element ${key}: levelId '${String(levelId)}' is not a known level`);
    }
  }
  if (
    category === 'curvedWall' &&
    isVec2(element['start']) &&
    isVec2(element['through']) &&
    isVec2(element['end']) &&
    !arcThrough(element['start'], element['through'], element['end'])
  ) {
    errors.push(`building element ${key}: start, through and end are collinear`);
  }
  if (category === 'wall') errors.push(...wallLayerErrors(key, element));
  if (category === 'connection') errors.push(...connectionErrors(key, element, elements));
  if (category === 'plate') errors.push(...plateErrors(key, element, elements));
  if (category === 'pipeSupport') errors.push(...pipeSupportErrors(key, element, elements));
  if (category === 'door' || category === 'window') {
    errors.push(...openingHostErrors(key, element, elements));
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
  if (raw['uid'] !== undefined && typeof raw['uid'] !== 'string')
    errors.push('building.uid must be a string');
  const counters = raw['counters'];
  if (
    counters !== undefined &&
    !(
      isRecord(counters) &&
      Object.values(counters).every(
        (value) => typeof value === 'number' && Number.isInteger(value) && value >= 0,
      )
    )
  ) {
    errors.push('building.counters must map id prefixes to non-negative integers');
  }
  if (!isRecord(levels)) return [...errors, 'building.levels must be an object'];
  if (!isRecord(elements)) return [...errors, 'building.elements must be an object'];
  for (const [key, level] of Object.entries(levels)) {
    const valid =
      isRecord(level) &&
      level['id'] === key &&
      typeof level['name'] === 'string' &&
      isFiniteNumber(level['elevation']) &&
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
    errors.push(...elementErrors(key, element, levels, elements));
  return errors;
}
