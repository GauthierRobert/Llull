/** `DocumentExtension` of the scan plugin: load-time validation of `CadDocument.scan` (no derived entities). */

import type { DocumentExtension } from '@core/plugins/plugin';
import { isRecord } from '@lib/isRecord';
import { EMPTY_SCAN } from './model';

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

/** Errors of `scan.acceptanceLedger` (absent: none): acceptances a replay re-applies, each with the signature object that proves it. */
function ledgerErrors(raw: Record<string, unknown>): string[] {
  const scan = raw['scan'];
  const ledger = isRecord(scan) ? scan['acceptanceLedger'] : undefined;
  if (ledger === undefined) return [];
  if (!Array.isArray(ledger)) return ['scan.acceptanceLedger must be a list'];
  return ledger.flatMap((entry, index) => {
    const at = `scan.acceptanceLedger[${index}]`;
    if (!isRecord(entry)) return [`${at} is malformed`];
    const problems: string[] = [];
    if (entry['act'] !== 'accept_asbuilt_extraction' && entry['act'] !== 'accept_registration')
      problems.push(`${at}.act must be accept_asbuilt_extraction or accept_registration`);
    for (const key of ['targetId', 'payload', 'signer', 'signatureId'])
      if (typeof entry[key] !== 'string' || entry[key] === '') problems.push(`${at}.${key} must be text`);
    if (typeof entry['documentUid'] !== 'string') problems.push(`${at}.documentUid must be text`);
    const signature = entry['signature'];
    if (!isRecord(signature) || Object.keys(signature).length === 0) problems.push(`${at}.signature must be a signature object`);
    return problems;
  });
}

export const scanDocument: DocumentExtension = {
  validate: (raw) => [...scanErrors(raw), ...ledgerErrors(raw)],
  derivedEntityIds: () => new Set(),
  restore: (raw) => raw,
  // Replay regenerates clouds, registrations and extractions from their steps: the acceptance ledger is kept so a recorded accept_* step re-applies its verified act.
  replaySeed: (base) => {
    const acceptanceLedger = base.scan?.acceptanceLedger;
    return acceptanceLedger === undefined || acceptanceLedger.length === 0 ? {} : { scan: { ...EMPTY_SCAN, acceptanceLedger } };
  },
};
