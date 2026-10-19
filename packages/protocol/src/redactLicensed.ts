/**
 * TR-MAT-32: licensed material values (licence `licensed-no-redistribution`) do not leave the machine in answers to a non-local client.
 * A material query on such a record keeps its descriptors (basis, unit, provenance incl. locator, ids, flags) and loses every number
 * that is a value (`value`, `kgPerM3`, tables, samples, derivatives); the answer says `redacted: true`.
 */

import type { CadDocument } from '@core/model/types';
import { getCommand } from '@core/commands/registry';
import { isRecord } from '@lib/isRecord';
import { hasLicensedMaterial, isLicensedMaterial, referencesLicensed } from './licensedReferences';

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

const GENERIC_SUMMARY = (name: string): string =>
  `${name}: numeric values withheld (inputs include a licensed-no-redistribution material, non-local client; redacted: true).`;

/** Drops every number (they may be, or derive from, licensed values); strings, booleans and structure stay. */
function stripNumbers(value: unknown): unknown {
  if (Array.isArray(value)) return value.filter((entry) => typeof entry !== 'number').map(stripNumbers);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => typeof entry !== 'number')
      .map(([key, entry]) => [key, stripNumbers(entry)]),
  );
}

interface Redactable {
  readonly summary: string;
  readonly data?: unknown;
}

function withRedactedData<T extends Redactable>(outcome: T, summary: string, data: unknown): T {
  return {
    ...outcome,
    summary,
    ...(outcome.data !== undefined ? { data: isRecord(data) ? { ...data, redacted: true } : { redacted: true } } : {}),
  };
}

/** Redacts an answer known to rest on a licensed material: descriptors only for value queries, else every number dropped. */
function redactAnswer<T extends Redactable>(name: string, material: string | undefined, outcome: T): T {
  if (VALUE_QUERIES.has(name) && material !== undefined)
    return withRedactedData(outcome, REDACTED_SUMMARY(name, material), strip(outcome.data));
  return withRedactedData(outcome, GENERIC_SUMMARY(name), stripNumbers(outcome.data));
}

/** `build_project`: each read-only step answer is redacted with its own command and the plan action it came from. */
function redactPlan<T extends Redactable>(doc: CadDocument, params: unknown, outcome: T): T {
  const data = outcome.data;
  if (!isRecord(data) || !Array.isArray(data['steps'])) return outcome;
  const actions = isRecord(params) && Array.isArray(params['actions']) ? (params['actions'] as unknown[]) : undefined;
  const aliases = isRecord(data['aliases']) ? (data['aliases'] as Record<string, readonly string[]>) : undefined;
  const steps = data['steps'].map((step: unknown) => {
    if (!isRecord(step) || step['data'] === undefined || typeof step['command'] !== 'string') return step;
    const action = actions !== undefined && typeof step['index'] === 'number' ? actions[step['index']] : undefined;
    if (action !== undefined ? !referencesLicensed(doc, action, aliases) : !hasLicensedMaterial(doc)) return step;
    const material = isRecord(action) && isRecord(action['params']) ? action['params']['material'] : undefined;
    const answer = redactAnswer(step['command'], typeof material === 'string' ? material : undefined, {
      summary: String(step['summary']),
      data: step['data'],
    });
    return { ...step, summary: answer.summary, data: answer.data };
  });
  return { ...outcome, data: { ...data, steps } };
}

/**
 * The outcome of `name(params)` for a non-local client: unchanged unless it is a read-only answer whose params (recursively) reference a
 * licensed material, directly or through an entity / fastener stack; then the summary is generic and `data` keeps descriptors (value
 * queries) or loses every number, with `redacted: true` at the top. `build_project` is redacted per step.
 * @invariant never adds information; a local client's outcome is never passed through this function
 */
export function redactLicensedOutcome<T extends Redactable>(doc: CadDocument, name: string, params: unknown, outcome: T): T {
  if (name === 'build_project') return redactPlan(doc, params, outcome);
  if (getCommand(name)?.annotations?.readOnly !== true || !referencesLicensed(doc, params)) return outcome;
  const material = isRecord(params) ? params['material'] : undefined;
  return redactAnswer(name, typeof material === 'string' && isLicensedMaterial(doc, material) ? material : undefined, outcome);
}
