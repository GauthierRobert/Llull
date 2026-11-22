/** Load-time validation of `EquipmentElement.plant` (persistence boundary): a corrupt record must be reported, never crash regeneration. */

import { isFiniteNumber, isPositiveNumber } from '@lib/isFiniteNumber';
import { isRecord } from '@lib/isRecord';
import { isVec3 } from '@lib/vec3';
import { headSpecSchema } from './model';
import { neckLengthOf } from './geometry/nozzleMass';
import { NOZZLE_KINDS, PLANT_EQUIPMENT_SCHEMA, type EquipmentTemplate, type NozzleRecord } from './plantData';
import { exchangerErrors, pumpErrors, supportErrors, tankErrors } from './validateTemplates';
import { appendAll } from '@lib/appendAll';

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
  const fit = ['insideDiameter', 'tangentLength', 'shellThickness'].every((name) => isPositiveNumber(template[name]))
    ? {
        shell: { from: 0, to: template['tangentLength'] as number },
        rootRadius: (template['insideDiameter'] as number) / 2 + (template['shellThickness'] as number),
      }
    : null;
  return [...errors, ...supportErrors(template['support'], at, template['orientation'] === 'horizontal' ? undefined : fit)];
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
  if (location['on'] === 'channel')
    return (location['channel'] === 'front' || location['channel'] === 'rear') &&
      isFiniteNumber(location['station']) &&
      isFiniteNumber(location['orientationDeg'])
      ? []
      : [`${at}: channel location needs channel (front or rear), station and orientationDeg`];
  if (location['on'] === 'head')
    return typeof location['head'] === 'string' && isFiniteNumber(location['radialOffset']) && isFiniteNumber(location['orientationDeg'])
      ? []
      : [`${at}: head location needs head, radialOffset and orientationDeg`];
  return [`${at}.on must be shell, head, channel or free`];
}

function nozzleErrors(nozzle: unknown, at: string, template: EquipmentTemplate | undefined): string[] {
  if (!isRecord(nozzle)) return [`${at} must be an object`];
  const errors: string[] = [];
  if (typeof nozzle['mark'] !== 'string' || nozzle['mark'] === '') errors.push(`${at}.mark must be a non-empty string`);
  if (typeof nozzle['rating'] !== 'string') errors.push(`${at}.rating must be a string`);
  if (nozzle['kind'] !== undefined && !NOZZLE_KINDS.some((kind) => kind === nozzle['kind']))
    errors.push(`${at}.kind must be one of ${NOZZLE_KINDS.join(', ')}`);
  if (nozzle['facing'] !== 'RF' && nozzle['facing'] !== 'FF' && nozzle['facing'] !== 'RTJ')
    errors.push(`${at}.facing must be RF, FF or RTJ`);
  for (const name of ['dn', 'projection', 'neckOutsideDiameter', 'neckWall'])
    if (!isPositiveNumber(nozzle[name])) errors.push(`${at}.${name} must be a number > 0`);
  const pad = nozzle['pad'];
  if (pad !== undefined) {
    if (!isRecord(pad) || !isPositiveNumber(pad['outsideDiameter']) || !isPositiveNumber(pad['thickness']))
      errors.push(`${at}.pad needs outsideDiameter and thickness > 0`);
    else if (isPositiveNumber(nozzle['neckOutsideDiameter']) && pad['outsideDiameter'] <= nozzle['neckOutsideDiameter'])
      errors.push(`${at}.pad.outsideDiameter must exceed neckOutsideDiameter`);
    else if (
      template !== undefined &&
      errors.length === 0 &&
      isRecord(nozzle['flange']) &&
      isPositiveNumber(nozzle['flange']['thickness'])
    ) {
      const neck = neckLengthOf(template, nozzle as unknown as NozzleRecord);
      if (!((pad['thickness'] as number) < neck))
        errors.push(`${at}.pad.thickness must be shorter than the neck above the wall (${+neck.toFixed(3)})`);
    }
  }
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
  const checks: ReadonlyMap<string, ((record: Record<string, unknown>, at: string) => string[]) | null> = new Map([
    ['vessel', vesselErrors],
    ['block', null],
    ['exchanger', exchangerErrors],
    ['tank', tankErrors],
    ['pump', pumpErrors],
  ]);
  const kind = isRecord(template) ? template['kind'] : undefined;
  const check = typeof kind === 'string' ? checks.get(kind) : undefined;
  if (!isRecord(template) || check === undefined) errors.push(`${at}.template.kind must be vessel, exchanger, tank, pump or block`);
  else if (check !== null) appendAll(errors, check(template, `${at}.template`));
  const soundTemplate = errors.length === 0 && isRecord(template) ? (template as unknown as EquipmentTemplate) : undefined;
  if (!Array.isArray(plant['nozzles'])) errors.push(`${at}.nozzles must be an array`);
  else plant['nozzles'].forEach((nozzle, index) => appendAll(errors, nozzleErrors(nozzle, `${at}.nozzles.${index}`, soundTemplate)));
  if (plant['design'] !== undefined && !isRecord(plant['design'])) errors.push(`${at}.design must be an object`);
  return errors;
}
