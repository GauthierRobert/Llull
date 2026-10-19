/** Load-time validation of the optional `prototype` field (interference intents, grounded parts). */

import { isRecord } from '../../lib/isRecord';
import { isStringArray } from '../../lib/isStringArray';
import { isReservedKey } from '../../lib/reservedKey';
import { INTENT_KINDS } from '../../model/prototype';
import { referencesProblems } from '../dynamics/engine/engineValidation';

const KINDS: readonly string[] = INTENT_KINDS;

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
  errors.push(...referencesProblems(value['references']));
  return errors;
}
