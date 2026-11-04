/** Load-time validation of the optional `instanceArrays` slice (VIS1): ids, references, count, table length and finiteness. */

import { isRecord } from '../../lib/isRecord';
import { isReservedKey } from '../../lib/reservedKey';
import { INSTANCE_ARRAY_ENCODINGS, MAX_ARRAY_INSTANCES, type InstanceArray } from '../../model/instanceArray';
import { decodedTransforms } from '../../geometry/instanceArrays';

const ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const HEX = /^#[0-9a-fA-F]{6}$/;

function problemOf(id: string, entry: unknown, doc: Record<string, unknown>): string | null {
  const at = `instanceArrays['${id}']`;
  if (isReservedKey(id) || !ID.test(id)) return `${at}: the id must match ${ID.source} and not be a reserved JavaScript property name`;
  if (!isRecord(entry) || entry['id'] !== id) return `${at} must be an object whose id is '${id}'`;
  const components = doc['components'];
  const layers = doc['layers'];
  if (typeof entry['componentId'] !== 'string' || !isRecord(components) || !Object.hasOwn(components, entry['componentId']))
    return `${at}: componentId must name an existing component`;
  if (typeof entry['layerId'] !== 'string' || !isRecord(layers) || !Object.hasOwn(layers, entry['layerId']))
    return `${at}: layerId must name an existing layer`;
  if (typeof entry['name'] !== 'string') return `${at}: name must be a string`;
  if (typeof entry['color'] !== 'string' || !HEX.test(entry['color'])) return `${at}: color must be #rrggbb`;
  if (entry['materialId'] !== undefined && typeof entry['materialId'] !== 'string') return `${at}: materialId must be a string`;
  const scale = entry['scale'];
  if (
    scale !== undefined &&
    !(Array.isArray(scale) && scale.length === 3 && scale.every((n) => typeof n === 'number' && Number.isFinite(n)))
  )
    return `${at}: scale must be 3 finite numbers`;
  const { count } = entry;
  if (typeof count !== 'number' || !Number.isInteger(count) || count < 1 || count > MAX_ARRAY_INSTANCES)
    return `${at}: count must be an integer in [1, ${MAX_ARRAY_INSTANCES}]`;
  if (!INSTANCE_ARRAY_ENCODINGS.some((encoding) => encoding === entry['encoding']))
    return `${at}: encoding must be one of ${INSTANCE_ARRAY_ENCODINGS.join(', ')}`;
  if (decodedTransforms(entry as unknown as InstanceArray) === null)
    return `${at}: transforms must be base64 of ${count} x 6 finite little-endian float64 (position x y z, rotation rx ry rz)`;
  return null;
}

/** Problems of the optional `instanceArrays` field of a raw document (absent is valid). */
export function instanceArrayProblems(value: unknown, doc: Record<string, unknown>): string[] {
  if (value === undefined) return [];
  if (!isRecord(value)) return ['instanceArrays must be an object keyed by array id'];
  return Object.entries(value).flatMap(([id, entry]) => {
    const problem = problemOf(id, entry, doc);
    return problem === null ? [] : [problem];
  });
}
