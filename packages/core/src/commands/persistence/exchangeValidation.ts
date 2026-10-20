/** Load-time validation of the optional `exchange` field (aerospace 04 XCH): import provenance per imported entity / component. */

import { isRecord } from '../../lib/isRecord';
import { isFiniteNumber } from '../../lib/isFiniteNumber';
import { isReservedKey } from '../../lib/reservedKey';

const FORMATS: ReadonlySet<unknown> = new Set(['step', 'iges']);
const UNITS: ReadonlySet<unknown> = new Set(['mm', 'cm', 'm', 'in', 'ft', 'unknown']);
const REASONS: ReadonlySet<unknown> = new Set(['import_gvp_red', 'import_gvp_not_checkable', 'verify_skipped', 'non_rigid_occurrence']);
const BANDS: ReadonlySet<unknown> = new Set(['green', 'yellow', 'red', 'not-checkable']);
const MAX_EMBEDDED = 4096;

const isVec3 = (value: unknown): boolean => Array.isArray(value) && value.length === 3 && value.every(isFiniteNumber);

function embeddedProblem(entry: unknown): string | null {
  if (!isRecord(entry)) return 'embeddedGvp entries must be objects';
  if (entry['target'] !== 'part' && entry['target'] !== 'assembly' && entry['target'] !== 'independent-surface')
    return 'embeddedGvp.target is unknown';
  if (typeof entry['placeholder'] !== 'boolean') return 'embeddedGvp.placeholder must be a boolean';
  for (const key of ['volume', 'area'])
    if (entry[key] !== undefined && !isFiniteNumber(entry[key])) return `embeddedGvp.${key} must be a finite number`;
  return entry['centroid'] !== undefined && !isVec3(entry['centroid']) ? 'embeddedGvp.centroid must be [x, y, z]' : null;
}

function recordProblem(record: unknown): string | null {
  if (!isRecord(record)) return 'is not an object';
  if (!FORMATS.has(record['format'])) return "format must be 'step' or 'iges'";
  if (typeof record['fileName'] !== 'string' || typeof record['sha256'] !== 'string' || typeof record['productName'] !== 'string')
    return 'fileName, sha256 and productName must be strings';
  if (record['schemaName'] !== null && typeof record['schemaName'] !== 'string') return 'schemaName must be a string or null';
  if (!UNITS.has(record['sourceUnit'])) return 'sourceUnit is unknown';
  const unverified = record['unverified'];
  if (
    !isRecord(unverified) ||
    typeof unverified['value'] !== 'boolean' ||
    !Array.isArray(unverified['reasons']) ||
    !unverified['reasons'].every((reason) => REASONS.has(reason))
  )
    return 'unverified must be { value: boolean, reasons: known reasons }';
  const embedded = record['embeddedGvp'];
  if (embedded !== undefined) {
    if (!Array.isArray(embedded) || embedded.length > MAX_EMBEDDED) return 'embeddedGvp must be a short array';
    for (const entry of embedded) {
      const problem = embeddedProblem(entry);
      if (problem !== null) return problem;
    }
  }
  const check = record['gvpCheck'];
  if (
    check !== undefined &&
    (!isRecord(check) || !BANDS.has(check['band']) || !Array.isArray(check['comparisons']) || !isRecord(check['policy']))
  )
    return 'gvpCheck must be { band, comparisons, policy }';
  return null;
}

export function exchangeProblems(value: unknown): string[] {
  if (value === undefined) return [];
  if (!isRecord(value) || !isRecord(value['provenance'])) return ['exchange must be { provenance: { <id>: record } }'];
  const errors: string[] = [];
  for (const [id, record] of Object.entries(value['provenance'])) {
    if (isReservedKey(id)) errors.push(`exchange.provenance: id '${id}' is a reserved JavaScript property name`);
    const problem = recordProblem(record);
    if (problem !== null) errors.push(`exchange.provenance['${id}'] ${problem}`);
  }
  return errors;
}
