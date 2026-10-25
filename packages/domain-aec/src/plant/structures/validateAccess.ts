/** Structural validation of the access elements of a loaded building (06 STA: grating panels and railings). */

import { isFiniteNumber } from '@lib/isFiniteNumber';
import { isRecord } from '@lib/isRecord';
import { isStringArray } from '@lib/isStringArray';
import { isVec3 } from '@lib/vec3';

const isPoint = (value: unknown): boolean => Array.isArray(value) && value.length >= 2 && value.every(isFiniteNumber);

function railingOpeningErrors(key: string, openings: unknown): string[] {
  const valid =
    Array.isArray(openings) &&
    openings.every(
      (opening) =>
        isRecord(opening) && isFiniteNumber(opening['from']) && isFiniteNumber(opening['to']) && typeof opening['gate'] === 'boolean',
    );
  return valid ? [] : [`building element ${key}: openings must be { from, to, gate } records`];
}

function railingHostErrors(key: string, host: unknown, elements: Record<string, unknown>): string[] {
  if (host === undefined) return [];
  const target = isRecord(host) && typeof host['hostId'] === 'string' ? elements[host['hostId']] : undefined;
  const valid =
    isRecord(host) &&
    isRecord(target) &&
    (target['category'] === 'slab' || target['category'] === 'grating') &&
    (host['ring'] === 'boundary' || (typeof host['ring'] === 'number' && Number.isInteger(host['ring']))) &&
    Array.isArray(host['edges']) &&
    host['edges'].every((edge) => typeof edge === 'number' && Number.isInteger(edge) && edge >= 0);
  return valid ? [] : [`building element ${key}: host must be { hostId (a slab or grating), ring, edges }`];
}

/** Problems with the category-specific fields of a `grating` or `railing` element (other categories: none). */
export function accessElementErrors(key: string, element: Record<string, unknown>, elements: Record<string, unknown>): string[] {
  const category = element['category'];
  const errors: string[] = [];
  if (category === 'grating') {
    const boundary = element['boundary'];
    if (!(Array.isArray(boundary) && boundary.length >= 3 && boundary.every(isPoint)))
      errors.push(`building element ${key}: boundary must be a polygon of ≥ 3 [x, y] points`);
    if (typeof element['gratingType'] !== 'string') errors.push(`building element ${key}: gratingType must be a string`);
    if (!(isStringArray(element['supportIds']) && element['supportIds'].length === 2))
      errors.push(`building element ${key}: supportIds must list two member ids`);
  }
  if (category === 'railing') {
    const path = element['path'];
    if (!(Array.isArray(path) && path.length >= 2 && path.every(isVec3)))
      errors.push(`building element ${key}: path must be ≥ 2 [x, y, z] points`);
    for (const field of ['postProfile', 'railProfile']) {
      if (typeof element[field] !== 'string') errors.push(`building element ${key}: ${field} must be a string`);
    }
    if (element['role'] !== 'guardrail' && element['role'] !== 'handrail')
      errors.push(`building element ${key}: role must be guardrail or handrail`);
    errors.push(...railingOpeningErrors(key, element['openings']), ...railingHostErrors(key, element['host'], elements));
  }
  return errors;
}
