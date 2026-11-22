/** Structural validation of a loaded winder / spiral stair element (06 STA §13.15). */

import { isFiniteNumber } from '@lib/isFiniteNumber';
import { isRecord } from '@lib/isRecord';
import { isVec3 } from '@lib/vec3';
import { findProfile } from '../../../steel/profiles';
import { MAX_RADIAL_RISERS } from './radialLayout';
import { findGratingType } from '../grating/gratingTypes';

const isPoint = (value: unknown): boolean => Array.isArray(value) && value.length === 2 && value.every(isFiniteNumber);

export function radialStairErrors(key: string, element: Record<string, unknown>): string[] {
  const errors: string[] = [];
  const bad = (message: string): number => errors.push(`building element ${key}: ${message}`);
  if (element['form'] !== 'winder' && element['form'] !== 'spiral') bad('form must be winder or spiral');
  if (element['turn'] !== 'left' && element['turn'] !== 'right') bad('turn must be left or right');
  if (!isVec3(element['start'])) bad('start must be [x, y, z]');
  const profile = element['profile'];
  if (typeof profile !== 'string' || findProfile(profile) === undefined) bad('profile must be a catalogue profile');
  const tread = element['tread'];
  const treadValid =
    isRecord(tread) &&
    ((tread['kind'] === 'grating' && typeof tread['gratingType'] === 'string' && findGratingType(tread['gratingType']) !== undefined) ||
      (tread['kind'] === 'checker_plate' && isFiniteNumber(tread['thickness']) && tread['thickness'] > 0));
  if (!treadValid) bad('tread must be a catalogue grating or a checker_plate with a thickness');
  const riserCount = element['riserCount'];
  const risersValid = typeof riserCount === 'number' && Number.isInteger(riserCount) && riserCount >= 2 && riserCount <= MAX_RADIAL_RISERS;
  if (!risersValid) bad(`riserCount must be an integer in 2..${MAX_RADIAL_RISERS}`);
  const plates = element['plates'];
  const platesValid =
    Array.isArray(plates) &&
    plates.length > 0 &&
    plates.every(
      (plate) =>
        isRecord(plate) &&
        isFiniteNumber(plate['top']) &&
        Array.isArray(plate['corners']) &&
        plate['corners'].length >= 3 &&
        plate['corners'].every(isPoint),
    );
  if (!platesValid) bad('plates must be treads { corners (3+ [x, y]), top }');
  else if (risersValid && plates.length !== riserCount - 1) bad('plates must hold one tread per riser but the last (riserCount - 1)');
  const sector = element['sector'];
  if (sector !== undefined) {
    const sectorValid =
      element['form'] === 'spiral' &&
      isRecord(sector) &&
      ['innerRadius', 'outerRadius', 'treadAngle'].every((field) => isFiniteNumber(sector[field]) && (sector[field] as number) > 0) &&
      (sector['outerRadius'] as number) > (sector['innerRadius'] as number);
    if (!sectorValid) bad('sector must be { innerRadius < outerRadius, treadAngle } (positive numbers) of a spiral');
  }
  const runs = element['runs'];
  if (!(Array.isArray(runs) && runs.every((run) => isRecord(run) && isVec3(run['from']) && isVec3(run['to']))))
    bad('runs must be { from, to } [x, y, z] pairs');
  return errors;
}
