/** Structural validation of a loaded winder / spiral stair element (06 STA §13.15). */

import { isFiniteNumber } from '@lib/isFiniteNumber';
import { isRecord } from '@lib/isRecord';
import { isVec3 } from '@lib/vec3';
import { findProfile } from '../../../steel/profiles';
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
  const runs = element['runs'];
  if (!(Array.isArray(runs) && runs.every((run) => isRecord(run) && isVec3(run['from']) && isVec3(run['to']))))
    bad('runs must be { from, to } [x, y, z] pairs');
  return errors;
}
