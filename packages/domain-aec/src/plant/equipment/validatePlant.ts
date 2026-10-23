/** Load-time validation of `EquipmentElement.plant` (persistence boundary): a corrupt record must be reported, never crash regeneration. */

import { isFiniteNumber, isPositiveNumber } from '@lib/isFiniteNumber';
import { isRecord } from '@lib/isRecord';
import { isVec3 } from '@lib/vec3';
import { headSpecSchema } from './model';
import { PLANT_EQUIPMENT_SCHEMA } from './plantData';

const SUPPORT_NUMBERS: Readonly<Record<string, readonly string[]>> = {
  skirt: ['height', 'thickness', 'baseRingWidth'],
  legs: ['count', 'height', 'pitchDiameter', 'legWidth'],
  saddles: ['width', 'axisElevation'],
  none: ['baseElevation'],
};

function supportErrors(support: unknown, at: string): string[] {
  if (!isRecord(support) || typeof support['type'] !== 'string' || SUPPORT_NUMBERS[support['type']] === undefined)
    return [`${at}.support.type must be skirt, legs, saddles or none`];
  const errors = (SUPPORT_NUMBERS[support['type']] as readonly string[])
    .filter((name) => !isFiniteNumber(support[name]) || (support[name] as number) < 0)
    .map((name) => `${at}.support.${name} must be a number >= 0`);
  if (support['type'] === 'saddles' && !(Array.isArray(support['stations']) && support['stations'].every(isFiniteNumber)))
    errors.push(`${at}.support.stations must be an array of numbers`);
  return errors;
}

function vesselErrors(template: Record<string, unknown>, at: string): string[] {
  const errors: string[] = [];
  if (template['orientation'] !== 'vertical' && template['orientation'] !== 'horizontal')
    errors.push(`${at}.orientation must be vertical or horizontal`);
  for (const name of ['insideDiameter', 'tangentLength', 'shellThickness', 'headThickness'])
    if (!isPositiveNumber(template[name])) errors.push(`${at}.${name} must be a number > 0`);
  if (!isFiniteNumber(template['corrosionAllowance']) || (template['corrosionAllowance'] as number) < 0)
    errors.push(`${at}.corrosionAllowance must be a number >= 0`);
  const heads = template['heads'];
  for (const name of ['first', 'second'])
    if (!isRecord(heads) || !headSpecSchema.safeParse(heads[name]).success) errors.push(`${at}.heads.${name} must be a head spec`);
  return [...errors, ...supportErrors(template['support'], at)];
}

function locationErrors(location: unknown, at: string): string[] {
  if (!isRecord(location)) return [`${at} must be an object`];
  if (location['on'] === 'free')
    return isVec3(location['position']) && isVec3(location['direction'])
      ? []
      : [`${at}: free location needs position and direction [x, y, z]`];
  if (location['on'] === 'shell')
    return isFiniteNumber(location['elevation']) !== isFiniteNumber(location['station']) && isFiniteNumber(location['orientationDeg'])
      ? []
      : [`${at}: shell location needs elevation or station, and orientationDeg`];
  if (location['on'] === 'head')
    return typeof location['head'] === 'string' && isFiniteNumber(location['radialOffset']) && isFiniteNumber(location['orientationDeg'])
      ? []
      : [`${at}: head location needs head, radialOffset and orientationDeg`];
  return [`${at}.on must be shell, head or free`];
}

function nozzleErrors(nozzle: unknown, at: string): string[] {
  if (!isRecord(nozzle)) return [`${at} must be an object`];
  const errors: string[] = [];
  if (typeof nozzle['mark'] !== 'string' || nozzle['mark'] === '') errors.push(`${at}.mark must be a non-empty string`);
  if (typeof nozzle['rating'] !== 'string') errors.push(`${at}.rating must be a string`);
  if (nozzle['facing'] !== 'RF' && nozzle['facing'] !== 'FF' && nozzle['facing'] !== 'RTJ')
    errors.push(`${at}.facing must be RF, FF or RTJ`);
  for (const name of ['dn', 'projection', 'neckOutsideDiameter', 'neckWall'])
    if (!isPositiveNumber(nozzle[name])) errors.push(`${at}.${name} must be a number > 0`);
  const flange = nozzle['flange'];
  if (!isRecord(flange) || !isPositiveNumber(flange['outsideDiameter']) || !isPositiveNumber(flange['thickness']))
    errors.push(`${at}.flange needs outsideDiameter and thickness > 0`);
  return [...errors, ...locationErrors(nozzle['location'], `${at}.location`)];
}

/** Problems of an equipment `plant` record (empty when it is absent or sound). */
export function plantDataErrors(key: string, plant: unknown): string[] {
  if (plant === undefined) return [];
  const at = `building element ${key}: plant`;
  if (!isRecord(plant) || plant['schema'] !== PLANT_EQUIPMENT_SCHEMA) return [`${at}.schema must be ${PLANT_EQUIPMENT_SCHEMA}`];
  const errors: string[] = [];
  const template = plant['template'];
  if (!isRecord(template) || (template['kind'] !== 'vessel' && template['kind'] !== 'block'))
    errors.push(`${at}.template.kind must be vessel or block`);
  else if (template['kind'] === 'vessel') errors.push(...vesselErrors(template, `${at}.template`));
  if (!Array.isArray(plant['nozzles'])) errors.push(`${at}.nozzles must be an array`);
  else plant['nozzles'].forEach((nozzle, index) => errors.push(...nozzleErrors(nozzle, `${at}.nozzles.${index}`)));
  if (plant['design'] !== undefined && !isRecord(plant['design'])) errors.push(`${at}.design must be an object`);
  return errors;
}
