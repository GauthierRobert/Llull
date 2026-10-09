/**
 * Value validation of a raw (loaded) civil model: persistence rejects files with errors.
 * @layer domain-aec/civil
 * @pure
 */

import { CIVIL_CATEGORIES } from '@core/model/civil';
import { isRecord } from '@lib/isRecord';

type Check = (object: Record<string, unknown>) => string | null;

const finite = (value: unknown): boolean => typeof value === 'number' && Number.isFinite(value);
const positive = (value: unknown): boolean => finite(value) && (value as number) > 0;

function isVecList(value: unknown, size: number, minimum: number): boolean {
  return (
    Array.isArray(value) &&
    value.length >= minimum &&
    value.every((item) => Array.isArray(item) && item.length === size && item.every(finite))
  );
}

function demand(condition: boolean, message: string): string | null {
  return condition ? null : message;
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
              isVecList([point['position']], 3, 1),
          ),
        'points must be { number, position: [x, y, z] } entries',
      ),
  ],
  surface: [
    (o) =>
      demand(
        Array.isArray(o['pointGroupIds']) &&
          (o['pointGroupIds'] as unknown[]).every((id) => typeof id === 'string'),
        'pointGroupIds must be strings',
      ),
    (o) => demand(isVecList(o['extraPoints'], 3, 0), 'extraPoints must be [x, y, z] points'),
    (o) => demand(positive(o['contourInterval']), 'contourInterval must be > 0'),
    (o) => demand(finite(o['majorEvery']) && (o['majorEvery'] as number) >= 0, 'bad majorEvery'),
    (o) =>
      demand(o['boundary'] === undefined || isVecList(o['boundary'], 2, 3), 'bad boundary'),
  ],
  platform: [
    (o) => demand(typeof o['surfaceId'] === 'string', 'surfaceId must be a string'),
    (o) => demand(isVecList(o['boundary'], 2, 3), 'boundary must have >= 3 [x, y] points'),
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
    (o) => demand(finite(o['startStation']), 'startStation must be a number'),
    (o) => demand(positive(o['stationInterval']), 'stationInterval must be > 0'),
    (o) => demand(Array.isArray(o['profile']), 'profile must be an array'),
  ],
  manhole: [
    (o) => demand(isVecList([o['position']], 2, 1), 'position must be [x, y]'),
    (o) => demand(finite(o['rimElevation']) && finite(o['invertElevation']), 'bad elevations'),
    (o) => demand(positive(o['diameter']), 'diameter must be > 0'),
  ],
  pipe: [
    (o) => demand(typeof o['fromId'] === 'string' && typeof o['toId'] === 'string', 'bad ends'),
    (o) => demand(positive(o['diameter']) && positive(o['manningN']), 'bad diameter / n'),
    (o) => demand(finite(o['invertFrom']) && finite(o['invertTo']), 'bad inverts'),
  ],
};

/** Errors in a raw civil model (empty when valid). */
export function civilErrors(raw: unknown): string[] {
  if (!isRecord(raw)) return ['civil must be an object'];
  const objects = raw['objects'];
  const order = raw['order'];
  if (!isRecord(objects)) return ['civil.objects must be an object'];
  if (!Array.isArray(order) || !order.every((id) => typeof id === 'string')) {
    return ['civil.order must be an array of ids'];
  }
  if (!isRecord(raw['counters'])) return ['civil.counters must be an object'];
  const errors: string[] = [];
  for (const id of order as string[]) {
    if (!(id in objects)) errors.push(`civil.order lists unknown object ${id}`);
  }
  for (const [id, object] of Object.entries(objects)) {
    const where = `civil.objects.${id}`;
    if (!isRecord(object) || object['id'] !== id) {
      errors.push(`${where} is malformed`);
      continue;
    }
    const category = CIVIL_CATEGORIES.find((candidate) => candidate === object['category']);
    if (category === undefined) {
      errors.push(`${where}.category is unknown`);
      continue;
    }
    if (typeof object['name'] !== 'string' || !Array.isArray(object['entityIds'])) {
      errors.push(`${where} needs a name and entityIds`);
      continue;
    }
    for (const check of CHECKS[category]) {
      const message = check(object);
      if (message !== null) errors.push(`${where}: ${message}`);
    }
  }
  return errors;
}
