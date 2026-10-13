import { isRecord } from '../../lib/isRecord';
import { isStringArray } from '../../lib/isStringArray';
import { isFiniteNumber } from '../../lib/isFiniteNumber';
import { isVec3 } from '../../lib/vec3';
import { validateEntityValue } from './guards';

/** First problem of a saved entity group, or null. */
export function validateGroupValue(key: string, v: unknown): string | null {
  if (!isRecord(v)) return `group '${key}' is not an object`;
  if (typeof v['id'] !== 'string' || typeof v['name'] !== 'string') return `group '${key}': id and name must be strings`;
  return isStringArray(v['memberIds']) ? null : `group '${key}': memberIds must be an array of entity id strings`;
}

/** First problem of a saved animation clip, or null. */
export function validateAnimationValue(key: string, v: unknown): string | null {
  if (!isRecord(v)) return `animation '${key}' is not an object`;
  const bad = (what: string): string => `animation '${key}': ${what}`;
  if (typeof v['id'] !== 'string' || typeof v['targetId'] !== 'string') return bad('id and targetId must be strings');
  if (v['targetKind'] !== 'entity' && v['targetKind'] !== 'group') return bad("targetKind must be 'entity' or 'group'");
  if (v['channel'] !== 'rotation' && v['channel'] !== 'position') return bad("channel must be 'rotation' or 'position'");
  if (v['mode'] !== 'spin' && v['mode'] !== 'oscillate') return bad("mode must be 'spin' or 'oscillate'");
  if (v['trigger'] !== 'auto' && v['trigger'] !== 'click') return bad("trigger must be 'auto' or 'click'");
  if (!isVec3(v['axis'])) return bad('axis must be [x, y, z] of finite numbers');
  if (!['speed', 'amplitude', 'frequency'].every((field) => isFiniteNumber(v[field])))
    return bad('speed, amplitude, frequency must be finite');
  return v['pivot'] === undefined || isVec3(v['pivot']) ? null : bad('pivot must be [x, y, z] of finite numbers');
}

/** First problem of a saved configuration, or null. */
export function validateConfigurationValue(key: string, v: unknown): string | null {
  if (!isRecord(v)) return `configuration '${key}' is not an object`;
  if (typeof v['name'] !== 'string') return `configuration '${key}': name must be a string`;
  const values = v['parameterValues'];
  const ok = isRecord(values) && Object.values(values).every((expression) => typeof expression === 'string');
  return ok ? null : `configuration '${key}': parameterValues must map parameter names to expression strings`;
}

/** First problem of a saved component definition (its entities are validated like document entities), or null. */
export function validateComponentValue(key: string, v: unknown): string | null {
  if (!isRecord(v)) return `component '${key}' is not an object`;
  if (typeof v['id'] !== 'string' || typeof v['name'] !== 'string') return `component '${key}': id and name must be strings`;
  const entities = v['entities'];
  if (!isRecord(entities) || !isStringArray(v['order'])) return `component '${key}': entities must be an object and order an array of ids`;
  for (const [id, entity] of Object.entries(entities)) {
    const problem = validateEntityValue(entity);
    if (problem !== null) return `component '${key}': ${problem}`;
    if (!isRecord(entity) || entity['id'] !== id) return `component '${key}': entity key '${id}' does not match entity.id`;
  }
  const dangling = v['order'].find((id) => !Object.hasOwn(entities, id));
  return dangling === undefined ? null : `component '${key}': order id '${dangling}' is not one of its entities`;
}
