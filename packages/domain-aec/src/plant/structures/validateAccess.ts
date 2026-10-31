/** Structural validation of the access elements of a loaded building (06 STA: grating panels and railings). */

import { isFiniteNumber } from '@lib/isFiniteNumber';
import { isRecord } from '@lib/isRecord';
import { isStringArray } from '@lib/isStringArray';
import { isVec3 } from '@lib/vec3';
import type { RailingElement } from '@aec/building/types';
import { findProfile } from '../../steel/profiles';
import { findGratingType } from './grating/gratingTypes';
import { railingStructureProblem } from './railing/railingValidate';

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
    (target['category'] === 'slab' || target['category'] === 'grating' || target['category'] === 'steelStair') &&
    (host['ring'] === 'boundary' || (typeof host['ring'] === 'number' && Number.isInteger(host['ring']))) &&
    Array.isArray(host['edges']) &&
    host['edges'].every((edge) => typeof edge === 'number' && Number.isInteger(edge) && edge >= 0);
  return valid ? [] : [`building element ${key}: host must be { hostId (a slab, grating or steel stair), ring, edges }`];
}

function ladderErrors(key: string, element: Record<string, unknown>): string[] {
  const errors: string[] = [];
  if (!isVec3(element['base'])) errors.push(`building element ${key}: base must be [x, y, z]`);
  if (element['exit'] !== 'through' && element['exit'] !== 'side_step')
    errors.push(`building element ${key}: exit must be through or side_step`);
  if (!['none', 'cage', 'ladder_safety_system', 'pfas'].includes(String(element['fallProtection'])))
    errors.push(`building element ${key}: fallProtection must be none, cage, ladder_safety_system or pfas`);
  const landings = element['landings'];
  if (!(Array.isArray(landings) && landings.every(isFiniteNumber)))
    errors.push(`building element ${key}: landings must be a list of heights`);
  const cage = element['cage'];
  if (cage !== undefined) {
    const valid = isRecord(cage) && ['startHeight', 'hoopSpacing', 'diameter', 'bars'].every((field) => isFiniteNumber(cage[field]));
    if (!valid) errors.push(`building element ${key}: cage must be { startHeight, hoopSpacing, diameter, bars }`);
  } else if (element['fallProtection'] === 'cage') errors.push(`building element ${key}: a caged ladder needs its cage data`);
  for (const field of ['installedOn', 'arrivalSurfaceId']) {
    if (element[field] !== undefined && typeof element[field] !== 'string')
      errors.push(`building element ${key}: ${field} must be a string`);
  }
  return errors;
}

function steelStairErrors(key: string, element: Record<string, unknown>): string[] {
  const errors: string[] = [];
  if (!isVec3(element['start'])) errors.push(`building element ${key}: start must be [x, y, z]`);
  if (typeof element['stringerProfile'] !== 'string' || findProfile(element['stringerProfile']) === undefined)
    errors.push(`building element ${key}: stringerProfile must be a catalogue profile`);
  const riserCount = element['riserCount'];
  if (typeof riserCount !== 'number' || !Number.isInteger(riserCount) || riserCount < 2)
    errors.push(`building element ${key}: riserCount must be an integer >= 2`);
  const tread = element['tread'];
  const treadValid =
    isRecord(tread) &&
    ((tread['kind'] === 'grating' && typeof tread['gratingType'] === 'string' && findGratingType(tread['gratingType']) !== undefined) ||
      (tread['kind'] === 'checker_plate' && isFiniteNumber(tread['thickness']) && tread['thickness'] > 0));
  if (!treadValid) errors.push(`building element ${key}: tread must be a catalogue grating or a checker_plate with a thickness`);
  const landings = element['landings'];
  const landingsValid =
    Array.isArray(landings) &&
    landings.every(
      (landing, index) =>
        isRecord(landing) &&
        typeof landing['afterRiser'] === 'number' &&
        Number.isInteger(landing['afterRiser']) &&
        landing['afterRiser'] >= 2 &&
        typeof riserCount === 'number' &&
        landing['afterRiser'] <= riserCount - 2 &&
        (index === 0 || landing['afterRiser'] > ((landings[index - 1] as Record<string, unknown>)['afterRiser'] as number)) &&
        isFiniteNumber(landing['length']) &&
        landing['length'] > 0,
    );
  if (!landingsValid)
    errors.push(`building element ${key}: landings must be ascending { afterRiser, length } leaving flights of 2+ risers`);
  if (element['arrivalSurfaceId'] !== undefined && typeof element['arrivalSurfaceId'] !== 'string')
    errors.push(`building element ${key}: arrivalSurfaceId must be a string`);
  return errors;
}

/** Problems with the category-specific fields of a `grating`, `railing`, `ladder` or `steelStair` element (other categories: none). */
export function accessElementErrors(key: string, element: Record<string, unknown>, elements: Record<string, unknown>): string[] {
  const category = element['category'];
  const errors: string[] = [];
  if (category === 'grating') {
    const boundary = element['boundary'];
    if (!(Array.isArray(boundary) && boundary.length >= 3 && boundary.every(isPoint)))
      errors.push(`building element ${key}: boundary must be a polygon of ≥ 3 [x, y] points`);
    if (typeof element['gratingType'] !== 'string') errors.push(`building element ${key}: gratingType must be a string`);
    const sides = element['supportIds'];
    if (!(Array.isArray(sides) && sides.length === 2 && sides.every((side) => isStringArray(side) && side.length > 0)))
      errors.push(`building element ${key}: supportIds must list the member ids of two support sides`);
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
    if (errors.length === 0) {
      const problem = railingStructureProblem(element as unknown as RailingElement);
      if (problem !== null) errors.push(`building element ${key}: ${problem.message}`);
    }
  }
  if (category === 'ladder') errors.push(...ladderErrors(key, element));
  if (category === 'steelStair') errors.push(...steelStairErrors(key, element));
  return errors;
}
