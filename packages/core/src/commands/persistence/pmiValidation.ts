import { DATUM_TARGET_KINDS, GEOMETRIC_CHARACTERISTICS, PMI_KINDS, PMI_STANDARDS, SIZE_MODIFIERS, ZONE_MODIFIERS } from '../../model/pmi';
import { VIEW_DIRECTIONS } from '../../model/sheet';
import { isRecord } from '../../lib/isRecord';
import { isStringArray } from '../../lib/isStringArray';
import { isFiniteNumber } from '../../lib/isFiniteNumber';
import { isReservedKey } from '../../lib/reservedKey';

const SAFE_ID = /^[A-Za-z0-9._-]+$/;
const isSafeId = (value: unknown): boolean => typeof value === 'string' && SAFE_ID.test(value);
const isOneOf = (list: ReadonlyArray<string>, value: unknown): boolean => typeof value === 'string' && list.includes(value);
const isVec = (value: unknown, length: number): boolean => Array.isArray(value) && value.length === length && value.every(isFiniteNumber);
const isOptional = (value: unknown, check: (v: unknown) => boolean): boolean => value === undefined || check(value);
const isPositive = (value: unknown): boolean => isFiniteNumber(value) && value > 0;

function featureProblem(where: string, feature: unknown): string | null {
  if (!isRecord(feature)) return `${where}: feature must be an object`;
  if (typeof feature['entityId'] !== 'string') return `${where}: feature.entityId must be a string`;
  const near = feature['facesNear'];
  if (!Array.isArray(near) || near.length === 0 || !near.every((p) => isVec(p, 3)))
    return `${where}: feature.facesNear must be a non-empty array of [x, y, z] finite points`;
  const indices = feature['faceIndices'];
  if (!Array.isArray(indices) || !indices.every((i) => Number.isInteger(i) && (i as number) >= 0))
    return `${where}: feature.faceIndices must be an array of non-negative integers`;
  if (typeof feature['surface'] !== 'string') return `${where}: feature.surface must be a string`;
  const size = feature['ofSize'];
  if (size !== undefined && (!isRecord(size) || !isOneOf(['cylinder', 'width', 'sphere'], size['kind']) || !isPositive(size['measured'])))
    return `${where}: feature.ofSize needs kind cylinder|width|sphere and a positive measured`;
  return null;
}

function toleranceProblem(where: string, tolerance: unknown): string | null {
  if (!isRecord(tolerance)) return `${where}: tolerance must be an object`;
  const type = tolerance['type'];
  if (type === 'basic') return null;
  if (!isOneOf(['plusMinus', 'limits', 'fit'], type)) return `${where}: tolerance.type must be plusMinus, limits, fit or basic`;
  if (!isFiniteNumber(tolerance['upper']) || !isFiniteNumber(tolerance['lower']))
    return `${where}: tolerance upper and lower must be finite numbers`;
  if (type === 'fit' && typeof tolerance['code'] !== 'string') return `${where}: a fit tolerance needs a code string`;
  return null;
}

function geometricProblem(where: string, item: Record<string, unknown>): string | null {
  if (!isOneOf(GEOMETRIC_CHARACTERISTICS, item['characteristic'])) return `${where}: unknown characteristic`;
  const target = item['target'];
  if (!isRecord(target)) return `${where}: target must be an object`;
  if (target['pmiId'] !== undefined) {
    if (typeof target['pmiId'] !== 'string') return `${where}: target.pmiId must be a string`;
  } else {
    const problem = featureProblem(where, target['feature']);
    if (problem !== null) return problem;
  }
  const zone = item['zone'];
  if (!isRecord(zone) || !isPositive(zone['value'])) return `${where}: zone.value must be a positive number`;
  for (const key of ['projectedLength', 'unequallyDisposed', 'maxValue'])
    if (!isOptional(zone[key], (v) => isFiniteNumber(v) && v >= 0)) return `${where}: zone.${key} must be a non-negative number`;
  if (!isOneOf(['MMC', 'LMC', 'RFS'], item['materialCondition'])) return `${where}: materialCondition must be MMC, LMC or RFS`;
  const modifiers = item['modifiers'];
  if (!Array.isArray(modifiers) || !modifiers.every((m) => isOneOf(ZONE_MODIFIERS, m))) return `${where}: modifiers must be zone modifiers`;
  const datums = item['datums'];
  if (!Array.isArray(datums) || datums.length > 3 || !datums.every((d) => isRecord(d) && typeof d['label'] === 'string'))
    return `${where}: datums must be at most 3 { label } references`;
  return isOptional(item['compositeOf'], (v) => typeof v === 'string') ? null : `${where}: compositeOf must be a string`;
}

/** The item-kind specific problem, or null. */
function kindProblem(where: string, item: Record<string, unknown>): string | null {
  switch (item['kind']) {
    case 'datum_feature':
      return typeof item['label'] === 'string' && /^[A-Z]{1,2}$/.test(item['label'])
        ? featureProblem(where, item['feature'])
        : `${where}: datum label must match ^[A-Z]{1,2}$`;
    case 'datum_target':
      if (typeof item['label'] !== 'string' || !Number.isInteger(item['targetNumber']) || !isOneOf(DATUM_TARGET_KINDS, item['targetKind']))
        return `${where}: datum target needs label, integer targetNumber and targetKind point|line|area`;
      return featureProblem(where, item['feature']);
    case 'size_dimension':
      if (!isOneOf(['diameter', 'radius', 'width', 'spherical_diameter'], item['sizeKind'])) return `${where}: unknown sizeKind`;
      if (!Number.isInteger(item['count']) || (item['count'] as number) < 1) return `${where}: count must be an integer >= 1`;
      if (!isOptional(item['sizeModifiers'], (v) => Array.isArray(v) && v.every((m) => isOneOf(SIZE_MODIFIERS, m))))
        return `${where}: sizeModifiers must be ISO 14405 codes`;
      return featureProblem(where, item['feature']) ?? toleranceProblem(where, item['tolerance']);
    case 'location_dimension':
      if (!isOneOf(['distance', 'angle'], item['measure']) || !isFiniteNumber(item['measured']))
        return `${where}: measure and measured are required`;
      return featureProblem(where, item['from']) ?? featureProblem(where, item['to']) ?? toleranceProblem(where, item['tolerance']);
    case 'geometric_tolerance':
      return geometricProblem(where, item);
    case 'surface_texture':
      if (typeof item['parameter'] !== 'string' || !isPositive(item['value']) || !isOneOf(['um', 'uin'], item['unit']))
        return `${where}: surface texture needs parameter, positive value and unit um|uin`;
      return featureProblem(where, item['feature']);
    default:
      if (typeof item['text'] !== 'string' || item['text'] === '') return `${where}: a note needs non-empty text`;
      return item['feature'] === undefined ? null : featureProblem(where, item['feature']);
  }
}

function itemProblem(key: string, item: unknown): string | null {
  const where = `pmi item '${key}'`;
  if (!isRecord(item)) return `${where} is not an object`;
  if (!isSafeId(key)) return `${where}: id must match [A-Za-z0-9._-]+`;
  if (item['id'] !== key) return `${where}: record key does not match item.id '${String(item['id'])}'`;
  if (!isOneOf(PMI_KINDS, item['kind'])) return `${where}: unknown kind`;
  const placement = item['placement'];
  const plane = isRecord(placement) ? placement['plane'] : undefined;
  if (
    !isRecord(placement) ||
    !isRecord(plane) ||
    !isVec(plane['origin'], 3) ||
    !isVec(plane['normal'], 3) ||
    !isVec(plane['xDir'], 3) ||
    !isVec(placement['position'], 2) ||
    typeof placement['auto'] !== 'boolean'
  )
    return `${where}: placement needs plane { origin, normal, xDir } [x, y, z], position [x, y] and auto`;
  const review = item['review'];
  if (!isRecord(review) || typeof review['required'] !== 'boolean') return `${where}: review.required must be a boolean`;
  return kindProblem(where, item);
}

function savedViewProblem(key: string, view: unknown, items: Record<string, unknown>): string | null {
  const where = `pmi saved view '${key}'`;
  if (!isRecord(view)) return `${where} is not an object`;
  if (!isSafeId(key) || view['id'] !== key) return `${where}: id must match its key and [A-Za-z0-9._-]+`;
  if (typeof view['name'] !== 'string') return `${where}: name must be a string`;
  const camera = view['camera'];
  if (
    !isRecord(camera) ||
    !isVec(camera['target'], 3) ||
    !isFiniteNumber(camera['azimuth']) ||
    !isFiniteNumber(camera['polar']) ||
    !isPositive(camera['distance'])
  )
    return `${where}: camera needs target [x, y, z], azimuth, polar and distance > 0`;
  const ids = view['pmiIds'];
  if (!isStringArray(ids)) return `${where}: pmiIds must be an array of strings`;
  const missing = ids.find((id) => !Object.hasOwn(items, id));
  if (missing !== undefined) return `${where}: pmiIds references unknown item '${missing}'`;
  if (!isOptional(view['entityIds'], isStringArray)) return `${where}: entityIds must be an array of strings`;
  const section = view['section'];
  if (
    section !== undefined &&
    (!isRecord(section) || !isOneOf(VIEW_DIRECTIONS, section['direction']) || !isFiniteNumber(section['offset']))
  )
    return `${where}: section needs a direction and a finite offset`;
  return null;
}

/** Problems of the optional `pmi` field of a raw document (absent is valid). */
export function pmiProblems(value: unknown): string[] {
  if (value === undefined) return [];
  if (!isRecord(value) || !isRecord(value['items']) || !isStringArray(value['order']))
    return ['pmi must be { standard, items: object, order: string[], savedViews, savedViewOrder }'];
  const { items, order } = value;
  const errors: string[] = [];
  if (!isOneOf(PMI_STANDARDS, value['standard'])) errors.push(`pmi.standard must be one of ${PMI_STANDARDS.join(', ')}`);
  if (!isOptional(value['generalToleranceNote'], (v) => typeof v === 'string')) errors.push('pmi.generalToleranceNote must be a string');
  const labels = new Map<string, string>();
  for (const [key, item] of Object.entries(items)) {
    if (isReservedKey(key)) errors.push(`pmi.items: id '${key}' is a reserved JavaScript property name`);
    const problem = itemProblem(key, item);
    if (problem !== null) errors.push(problem);
    if (isRecord(item) && item['kind'] === 'datum_feature' && typeof item['label'] === 'string') {
      const scope = `${String(isRecord(item['feature']) ? item['feature']['entityId'] : '')}/${item['label']}`;
      if (labels.has(scope)) errors.push(`pmi: datum label '${item['label']}' is used by both '${labels.get(scope)}' and '${key}'`);
      labels.set(scope, key);
    }
  }
  for (const item of Object.values(items)) {
    if (!isRecord(item)) continue;
    const target = item['target'];
    if (isRecord(target) && typeof target['pmiId'] === 'string' && !Object.hasOwn(items, target['pmiId']))
      errors.push(`pmi item '${String(item['id'])}': target.pmiId '${target['pmiId']}' is not a PMI item`);
  }
  const listed = new Set(order);
  if (listed.size !== order.length) errors.push('pmi.order contains duplicate ids');
  for (const id of order) if (!Object.hasOwn(items, id)) errors.push(`pmi.order: '${id}' does not reference a known item`);
  for (const id of Object.keys(items)) if (!listed.has(id)) errors.push(`pmi.order is missing item '${id}'`);
  const views = value['savedViews'];
  const viewOrder = value['savedViewOrder'];
  if (!isRecord(views) || !isStringArray(viewOrder))
    return [...errors, 'pmi.savedViews must be an object and pmi.savedViewOrder an array of strings'];
  for (const [key, view] of Object.entries(views)) {
    const problem = savedViewProblem(key, view, items);
    if (problem !== null) errors.push(problem);
  }
  if (
    new Set(viewOrder).size !== viewOrder.length ||
    viewOrder.length !== Object.keys(views).length ||
    !viewOrder.every((id) => Object.hasOwn(views, id))
  )
    errors.push('pmi.savedViewOrder must list every saved view exactly once');
  const active = value['activeSavedViewId'];
  if (active !== undefined && (typeof active !== 'string' || !Object.hasOwn(views, active)))
    errors.push('pmi.activeSavedViewId must name a saved view');
  return errors;
}
