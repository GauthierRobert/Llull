/**
 * TR-MAT-32: licensed material values (licence `licensed-no-redistribution`) do not leave the machine in answers to a non-local client.
 * A material query on such a record keeps its descriptors (basis, unit, provenance incl. locator, ids, flags) and loses every number
 * that is a value (`value`, `kgPerM3`, tables, samples, derivatives); the answer says `redacted: true`.
 */

import type { CadDocument } from '@core/model/types';
import { isRecord } from '@lib/isRecord';

/** Commands whose answers carry a material's values. */
const VALUE_QUERIES: ReadonlySet<string> = new Set(['get_material', 'get_material_allowable', 'evaluate_property', 'sample_property']);

/** Keys of a material answer that describe a value without being one; every other key is dropped from a redacted answer. */
const DESCRIPTORS: ReadonlySet<string> = new Set([
  'available',
  'material',
  'materialId',
  'property',
  'basis',
  'direction',
  'condition',
  'modelId',
  'baseModelId',
  'id',
  'form',
  'unit',
  'provenance',
  'baseProvenance',
  'unverified',
  'unverifiedReasons',
  'reviewRequired',
  'warnings',
  'code',
  'reason',
  'remediation',
  'path',
  'rangeStatus',
  'temperatureDependent',
  'preferred',
  'legacy',
  'record',
  'marking',
  'unresolved',
  'superseded',
  'source',
  'key',
  'at',
  'defaults',
  'density',
  'values',
  'candidates',
  'variable',
  'variableUnit',
]);

const REDACTED_SUMMARY = (name: string, material: string): string =>
  `${name} '${material}': values withheld (licensed-no-redistribution, non-local client; redacted: true). Basis, unit and provenance are in data.`;

/** Descriptors that hold further value-bearing objects. */
const CONTAINERS: ReadonlySet<string> = new Set(['density', 'values', 'candidates']);

function strip(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(strip);
  if (!isRecord(value)) return value;
  const entries = Object.entries(value).filter(([key]) => DESCRIPTORS.has(key));
  const dropped = entries.length < Object.keys(value).length;
  return Object.fromEntries([
    ...entries.map(([key, entry]) => [key, CONTAINERS.has(key) ? strip(entry) : entry]),
    ...(dropped ? [['redacted', true]] : []),
  ]);
}

/** True when the record behind `materialId` (or its library) is `licensed-no-redistribution`. */
function isLicensedMaterial(doc: CadDocument, materialId: string): boolean {
  const material = Object.hasOwn(doc.materials, materialId) ? doc.materials[materialId] : undefined;
  const record = material?.record;
  if (record === undefined) return false;
  const library = record.libraryRef === undefined ? undefined : doc.materialLibraries?.[record.libraryRef.libraryId];
  return record.licence === 'licensed-no-redistribution' || library?.licence === 'licensed-no-redistribution';
}

interface Redactable {
  readonly summary: string;
  readonly data?: unknown;
}

/**
 * The outcome of `name(params)` for a non-local client: unchanged unless it is a value query on a licensed record, in which case the
 * summary is generic and `data` keeps only descriptors, with `redacted: true` at the top.
 * @invariant never adds information; a local client's outcome is never passed through this function
 */
export function redactLicensedOutcome<T extends Redactable>(doc: CadDocument, name: string, params: unknown, outcome: T): T {
  if (!VALUE_QUERIES.has(name) || !isRecord(params)) return outcome;
  const material = params['material'];
  if (typeof material !== 'string' || !isLicensedMaterial(doc, material)) return outcome;
  const data = strip(outcome.data);
  return {
    ...outcome,
    summary: REDACTED_SUMMARY(name, material),
    ...(outcome.data !== undefined ? { data: isRecord(data) ? { ...data, redacted: true } : { redacted: true } } : {}),
  };
}
