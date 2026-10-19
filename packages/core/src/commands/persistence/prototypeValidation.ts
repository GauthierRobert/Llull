/** Load-time validation of the optional `prototype` field (interference intents, grounded parts, references, dispositions). */

import { isRecord } from '../../lib/isRecord';
import { isStringArray } from '../../lib/isStringArray';
import { isReservedKey } from '../../lib/reservedKey';
import { DISPOSITION_STATUSES, INTENT_KINDS, REVIEW_CHECKS } from '../../model/prototype';
import { referencesProblems } from './engineValidation';

const KINDS: readonly string[] = INTENT_KINDS;
const STATUSES: readonly string[] = DISPOSITION_STATUSES;

function intentProblem(id: string, intent: unknown): string | null {
  if (!isRecord(intent) || intent['id'] !== id) return `prototype.intents['${id}'] must be an object whose id is '${id}'`;
  if (typeof intent['a'] !== 'string' || typeof intent['b'] !== 'string' || intent['a'].length === 0 || intent['b'].length === 0)
    return `prototype.intents['${id}']: a and b must be non-empty strings`;
  if (intent['a'] === intent['b']) return `prototype.intents['${id}']: a and b must differ`;
  if (typeof intent['kind'] !== 'string' || !KINDS.includes(intent['kind']))
    return `prototype.intents['${id}']: kind must be one of ${KINDS.join(', ')}`;
  if (typeof intent['reason'] !== 'string' || intent['reason'].trim().length === 0)
    return `prototype.intents['${id}']: reason must be non-empty`;
  if (intent['declaredBy'] !== 'agent' && intent['declaredBy'] !== 'human')
    return `prototype.intents['${id}']: declaredBy must be 'agent' or 'human'`;
  return null;
}

/** True when `key` reads `<check>:<code>:<ids>` with a known review check and a non-empty code. */
export const isFindingKey = (key: string): boolean => {
  const [check, code, ...rest] = key.split(':');
  return REVIEW_CHECKS.some((name) => name === check) && code !== undefined && code.length > 0 && rest.length > 0;
};

function dispositionProblem(key: string, disposition: unknown): string | null {
  const at = `prototype.dispositions['${key}']`;
  if (!isRecord(disposition) || disposition['findingKey'] !== key) return `${at} must be an object whose findingKey is '${key}'`;
  if (!isFindingKey(key)) return `${at}: the key must read <check>:<code>:<ids> with check one of ${REVIEW_CHECKS.join(', ')}`;
  if (typeof disposition['status'] !== 'string' || !STATUSES.includes(disposition['status']))
    return `${at}: status must be one of ${STATUSES.join(', ')}`;
  if (typeof disposition['comment'] !== 'string') return `${at}: comment must be a string`;
  if (typeof disposition['inputsHash'] !== 'string' || disposition['inputsHash'].length === 0)
    return `${at}: inputsHash must be a non-empty string`;
  if (disposition['by'] !== 'agent' && disposition['by'] !== 'human') return `${at}: by must be 'agent' or 'human'`;
  return null;
}

function dispositionsProblems(value: unknown): string[] {
  if (value === undefined) return [];
  if (!isRecord(value)) return ['prototype.dispositions must be an object keyed by finding key'];
  return Object.entries(value).flatMap(([key, disposition]) => {
    const problem = isReservedKey(key)
      ? `prototype.dispositions: key '${key}' is a reserved JavaScript property name`
      : dispositionProblem(key, disposition);
    return problem === null ? [] : [problem];
  });
}

/** Problems of the optional `prototype` field of a raw document (absent is valid). */
export function prototypeProblems(value: unknown): string[] {
  if (value === undefined) return [];
  if (!isRecord(value) || !isRecord(value['intents']) || !isStringArray(value['grounded']))
    return ['prototype must be { intents: {…}, grounded: string[] }'];
  const errors: string[] = [];
  for (const [id, intent] of Object.entries(value['intents'])) {
    const problem = isReservedKey(id) ? `prototype.intents: id '${id}' is a reserved JavaScript property name` : intentProblem(id, intent);
    if (problem !== null) errors.push(problem);
  }
  if (new Set(value['grounded']).size !== value['grounded'].length) errors.push('prototype.grounded contains duplicate ids');
  errors.push(...referencesProblems(value['references']), ...dispositionsProblems(value['dispositions']));
  return errors;
}
