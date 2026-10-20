/** `DocumentExtension` of the scan plugin: load-time validation of `CadDocument.scan` (no derived entities). */

import type { DocumentExtension } from '@core/plugins/plugin';
import { isRecord } from '@lib/isRecord';

const isMat4 = (value: unknown): boolean =>
  Array.isArray(value) && value.length === 16 && value.every((v) => typeof v === 'number' && Number.isFinite(v));
const isVec3 = (value: unknown): boolean =>
  Array.isArray(value) && value.length === 3 && value.every((v) => typeof v === 'number' && Number.isFinite(v));

function tableErrors(
  scan: Record<string, unknown>,
  key: string,
  check: (id: string, value: Record<string, unknown>) => string | null,
): string[] {
  const table = scan[key];
  if (!isRecord(table)) return [`scan.${key} must be an object`];
  return Object.entries(table).flatMap(([id, value]) => {
    if (!isRecord(value) || value['id'] !== id) return [`scan.${key}['${id}'] is malformed`];
    const problem = check(id, value);
    return problem === null ? [] : [`scan.${key}['${id}']: ${problem}`];
  });
}

/** Value errors of the raw `scan` slice (persistence rejects the file when non-empty). */
export function scanErrors(raw: Record<string, unknown>): string[] {
  const scan = raw['scan'];
  if (scan === undefined) return [];
  if (!isRecord(scan)) return ['scan must be an object'];
  const errors = [
    ...tableErrors(scan, 'clouds', (_, cloud) =>
      typeof cloud['assetKey'] !== 'string' ||
      typeof cloud['name'] !== 'string' ||
      !isMat4(cloud['transform']) ||
      !isRecord(cloud['display'])
        ? 'needs assetKey, name, transform (16 numbers) and display'
        : null,
    ),
    ...tableErrors(scan, 'registrations', (_, record) =>
      typeof record['fixed'] !== 'string' || typeof record['moving'] !== 'string' || !isMat4(record['transform'])
        ? 'needs fixed, moving and transform'
        : null,
    ),
    ...tableErrors(scan, 'extractions', (_, record) =>
      typeof record['cloudId'] !== 'string' || typeof record['extractionHash'] !== 'string' || !Array.isArray(record['createdElementIds'])
        ? 'needs cloudId, extractionHash and createdElementIds'
        : null,
    ),
    ...tableErrors(scan, 'crops', (_, crop) => (!isVec3(crop['min']) || !isVec3(crop['max']) ? 'needs min and max' : null)),
  ];
  const order = scan['cloudOrder'];
  const clouds = isRecord(scan['clouds']) ? scan['clouds'] : {};
  if (
    !Array.isArray(order) ||
    order.some((id) => typeof id !== 'string' || !Object.hasOwn(clouds, id)) ||
    order.length !== Object.keys(clouds).length
  )
    errors.push('scan.cloudOrder must list every cloud id once');
  return errors;
}

export const scanDocument: DocumentExtension = { validate: scanErrors, derivedEntityIds: () => new Set(), restore: (raw) => raw };
