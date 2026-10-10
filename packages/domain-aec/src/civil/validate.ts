/**
 * Value validation of a raw (loaded) civil model: persistence rejects files with errors, so a
 * crafted or corrupt file can never reach regeneration with values it cannot evaluate.
 * @layer domain-aec/civil
 * @pure
 */

import { type ProfilePvi, CIVIL_CATEGORIES } from '@core/model/civil';
import type { Vec2 } from '@core/model/types';
import { isRecord } from '@lib/isRecord';
import { isValidPolygon } from '@lib/polygon';
import { validateHorizontal } from './alignmentGeometry';
import { validateProfile } from './profileGeometry';
import { MAX_SURFACE_POINTS } from './model';

type Check = (object: Record<string, unknown>) => string | null;

const finite = (value: unknown): boolean => typeof value === 'number' && Number.isFinite(value);
const positive = (value: unknown): boolean => finite(value) && (value as number) > 0;
const optional = (value: unknown, test: (value: unknown) => boolean): boolean =>
  value === undefined || test(value);

function isVecList(value: unknown, size: number, minimum: number): boolean {
  return (
    Array.isArray(value) &&
    value.length >= minimum &&
    value.every((item) => Array.isArray(item) && item.length === size && item.every(finite))
  );
}

function isStringList(value: unknown): boolean {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function demand(condition: boolean, message: string): string | null {
  return condition ? null : message;
}

function profileError(value: unknown): string | null {
  if (!Array.isArray(value)) return 'profile must be an array';
  const valid = value.every(
    (pvi) =>
      isRecord(pvi) &&
      finite(pvi['station']) &&
      finite(pvi['elevation']) &&
      finite(pvi['curveLength']),
  );
  if (!valid) return 'profile entries must be { station, elevation, curveLength } numbers';
  return value.length === 0 ? null : validateProfile(value as ProfilePvi[]);
}

function sectionError(value: unknown): string | null {
  if (value === undefined) return null;
  if (!isRecord(value)) return 'section must be an object';
  const ok =
    positive(value['laneWidth']) &&
    finite(value['shoulderWidth']) &&
    (value['shoulderWidth'] as number) >= 0 &&
    finite(value['crossfall']) &&
    positive(value['cutSlope']) &&
    positive(value['fillSlope']);
  return ok ? null : 'section needs laneWidth > 0, shoulderWidth >= 0, crossfall, slopes > 0';
}

function superelevationError(value: unknown): string | null {
  if (value === undefined) return null;
  const ok =
    isRecord(value) &&
    finite(value['maxRate']) &&
    (value['maxRate'] as number) > 0 &&
    (value['maxRate'] as number) <= 0.15 &&
    optional(value['runoffLength'], positive);
  return ok ? null : 'superelevation needs maxRate in (0, 0.15] and runoffLength > 0';
}

const CHECKS: Readonly<Record<(typeof CIVIL_CATEGORIES)[number], readonly Check[]>> = {
  pointGroup: [
    (o) =>
      demand(
        Array.isArray(o['points']) &&
          (o['points'] as unknown[]).every(
            (point) =>
              isRecord(point) &&
              typeof point['number'] === 'string' &&
              isVecList([point['position']], 3, 1) &&
              optional(point['code'], (code) => typeof code === 'string'),
          ),
        'points must be { number, position: [x, y, z] } entries',
      ),
  ],
  surface: [
    (o) => demand(isStringList(o['pointGroupIds']), 'pointGroupIds must be strings'),
    (o) => demand(isVecList(o['extraPoints'], 3, 0), 'extraPoints must be [x, y, z] points'),
    (o) => demand(positive(o['contourInterval']), 'contourInterval must be > 0'),
    (o) => demand(finite(o['majorEvery']) && (o['majorEvery'] as number) >= 0, 'bad majorEvery'),
    (o) =>
      demand(
        o['boundary'] === undefined ||
          (isVecList(o['boundary'], 2, 3) && isValidPolygon(o['boundary'] as Vec2[])),
        'bad boundary',
      ),
    (o) => demand(optional(o['maxEdgeLength'], positive), 'maxEdgeLength must be > 0'),
  ],
  platform: [
    (o) => demand(typeof o['surfaceId'] === 'string', 'surfaceId must be a string'),
    (o) =>
      demand(
        isVecList(o['boundary'], 2, 3) && isValidPolygon(o['boundary'] as Vec2[]),
        'boundary must be a simple polygon of >= 3 [x, y] points',
      ),
    (o) => demand(finite(o['elevation']), 'elevation must be a number'),
    (o) => demand(positive(o['cutSlope']) && positive(o['fillSlope']), 'slopes must be > 0'),
  ],
  alignment: [
    (o) => demand(isVecList(o['points'], 2, 2), 'points must have >= 2 [x, y] points'),
    (o) =>
      demand(
        Array.isArray(o['radii']) && (o['radii'] as unknown[]).every(finite),
        'radii must be numbers',
      ),
    (o) =>
      demand(
        optional(o['spirals'], (spirals) => Array.isArray(spirals) && spirals.every(finite)),
        'spirals must be numbers',
      ),
    (o) =>
      isVecList(o['points'], 2, 2) && Array.isArray(o['radii'])
        ? validateHorizontal(
            o['points'] as Vec2[],
            o['radii'] as number[],
            Array.isArray(o['spirals']) && (o['spirals'] as unknown[]).every(finite)
              ? (o['spirals'] as number[])
              : [],
          )
        : null,
    (o) => demand(finite(o['startStation']), 'startStation must be a number'),
    (o) => demand(positive(o['stationInterval']), 'stationInterval must be > 0'),
    (o) =>
      demand(
        optional(o['surfaceId'], (id) => typeof id === 'string'),
        'bad surfaceId',
      ),
    (o) => profileError(o['profile']),
    (o) => sectionError(o['section']),
    (o) => superelevationError(o['superelevation']),
  ],
  manhole: [
    (o) => demand(isVecList([o['position']], 2, 1), 'position must be [x, y]'),
    (o) => demand(finite(o['rimElevation']) && finite(o['invertElevation']), 'bad elevations'),
    (o) => demand(positive(o['diameter']), 'diameter must be > 0'),
    (o) =>
      demand(
        optional(
          o['catchment'],
          (catchment) =>
            isRecord(catchment) &&
            positive(catchment['areaHa']) &&
            finite(catchment['runoffCoefficient']) &&
            (catchment['runoffCoefficient'] as number) >= 0 &&
            (catchment['runoffCoefficient'] as number) <= 1,
        ),
        'catchment needs areaHa > 0 and runoffCoefficient in [0, 1]',
      ),
    (o) =>
      demand(
        optional(o['inflow'], (inflow) => finite(inflow) && (inflow as number) >= 0),
        'inflow must be >= 0',
      ),
    (o) =>
      demand(
        optional(o['entryTimeMin'], (entry) => positive(entry)),
        'entryTimeMin must be > 0',
      ),
  ],
  pipe: [
    (o) => demand(typeof o['fromId'] === 'string' && typeof o['toId'] === 'string', 'bad ends'),
    (o) => demand(typeof o['material'] === 'string', 'material must be a string'),
    (o) => demand(positive(o['diameter']) && positive(o['manningN']), 'bad diameter / n'),
    (o) => demand(finite(o['invertFrom']) && finite(o['invertTo']), 'bad inverts'),
  ],
};

function pointTotalErrors(objects: Record<string, unknown>): string[] {
  const groupSize = (id: unknown): number => {
    const group = typeof id === 'string' ? objects[id] : undefined;
    return isRecord(group) && Array.isArray(group['points']) ? group['points'].length : 0;
  };
  const errors: string[] = [];
  for (const [id, object] of Object.entries(objects)) {
    if (!isRecord(object) || object['category'] !== 'surface') continue;
    const groups = Array.isArray(object['pointGroupIds']) ? object['pointGroupIds'] : [];
    const extra = Array.isArray(object['extraPoints']) ? object['extraPoints'].length : 0;
    const total = groups.reduce((sum: number, group) => sum + groupSize(group), extra);
    if (total > MAX_SURFACE_POINTS) {
      errors.push(`civil.objects.${id}: ${total} points exceed the ${MAX_SURFACE_POINTS} limit`);
    }
  }
  return errors;
}

function crsErrors(raw: unknown): string[] {
  if (raw === undefined) return [];
  if (!isRecord(raw) || typeof raw['name'] !== 'string') return ['civil.crs needs a name'];
  const errors: string[] = [];
  if (!optional(raw['epsg'], (code) => Number.isInteger(code) && (code as number) > 0)) {
    errors.push('civil.crs.epsg must be a positive integer');
  }
  if (!optional(raw['verticalDatum'], (datum) => typeof datum === 'string')) {
    errors.push('civil.crs.verticalDatum must be a string');
  }
  const calibration = raw['calibration'];
  if (
    calibration !== undefined &&
    !(
      isRecord(calibration) &&
      isVecList([calibration['localOrigin'], calibration['gridOrigin']], 2, 2) &&
      finite(calibration['rotationDeg']) &&
      positive(calibration['scaleFactor'])
    )
  ) {
    errors.push('civil.crs.calibration needs 2 origins, rotationDeg and scaleFactor > 0');
  }
  return errors;
}

/** Errors in a raw civil model (empty when valid). */
export function civilErrors(raw: unknown): string[] {
  if (!isRecord(raw)) return ['civil must be an object'];
  const objects = raw['objects'];
  const order = raw['order'];
  if (!isRecord(objects)) return ['civil.objects must be an object'];
  if (!isStringList(order)) return ['civil.order must be an array of ids'];
  const counters = raw['counters'];
  if (!isRecord(counters) || !Object.values(counters).every(finite))
    return ['civil.counters must map prefixes to numbers'];
  const errors: string[] = crsErrors(raw['crs']);
  const ids = order as string[];
  if (new Set(ids).size !== ids.length) errors.push('civil.order lists an id twice');
  for (const id of ids) {
    if (!(id in objects)) errors.push(`civil.order lists unknown object ${id}`);
  }
  for (const [id, object] of Object.entries(objects)) {
    const where = `civil.objects.${id}`;
    if (!isRecord(object) || object['id'] !== id) {
      errors.push(`${where} is malformed`);
      continue;
    }
    if (!ids.includes(id)) errors.push(`${where} is missing from civil.order`);
    const category = CIVIL_CATEGORIES.find((candidate) => candidate === object['category']);
    if (category === undefined) {
      errors.push(`${where}.category is unknown`);
      continue;
    }
    if (typeof object['name'] !== 'string' || !isStringList(object['entityIds'])) {
      errors.push(`${where} needs a name and entityIds`);
      continue;
    }
    for (const check of CHECKS[category]) {
      const message = check(object);
      if (message !== null) errors.push(`${where}: ${message}`);
    }
  }
  return [...errors, ...pointTotalErrors(objects)];
}
