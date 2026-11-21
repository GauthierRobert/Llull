/** Load-time validation of the optional `prototype` field (interference intents, grounded parts, connection groups, references, dispositions). */

import { isRecord } from '../../lib/isRecord';
import { isStringArray } from '../../lib/isStringArray';
import { isReservedKey } from '../../lib/reservedKey';
import { CONNECTION_CYLINDRICAL, CONNECTION_KINDS, DISPOSITION_STATUSES, INTENT_KINDS, REVIEW_CHECKS } from '../../model/prototype';
import { referencesProblems } from './engineValidation';
import { appendAll } from '../../lib/appendAll';

const KINDS: readonly string[] = INTENT_KINDS;
const STATUSES: readonly string[] = DISPOSITION_STATUSES;
const CONNECTION_KIND_LIST: readonly string[] = CONNECTION_KINDS;
const CYLINDRICAL_LIST: readonly string[] = CONNECTION_CYLINDRICAL;
const MEMBER_KEYS = ['ids', 'patternOf', 'layerId', 'groupId'] as const;

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

function membersProblem(at: string, members: unknown): string | null {
  if (!isRecord(members)) return `${at}: members must be an object`;
  const present = MEMBER_KEYS.filter((key) => members[key] !== undefined);
  const [key] = present;
  if (present.length !== 1 || key === undefined) return `${at}: members must hold exactly one of ${MEMBER_KEYS.join(', ')}`;
  const value = members[key];
  if (key === 'ids') return isStringArray(value) && value.length > 0 ? null : `${at}: members.ids must be a non-empty array of strings`;
  return typeof value === 'string' && value.length > 0 ? null : `${at}: members.${key} must be a non-empty string`;
}

function detectProblem(at: string, detect: unknown): string | null {
  if (detect === undefined) return null;
  if (!isRecord(detect)) return `${at}: detect must be an object`;
  const { toleranceMm, faceAngleDeg, cylindrical } = detect;
  if (typeof toleranceMm !== 'number' || !Number.isFinite(toleranceMm) || toleranceMm <= 0) return `${at}: detect.toleranceMm must be > 0`;
  if (typeof faceAngleDeg !== 'number' || !Number.isFinite(faceAngleDeg) || faceAngleDeg < 0 || faceAngleDeg > 90)
    return `${at}: detect.faceAngleDeg must be within 0..90`;
  if (typeof cylindrical !== 'string' || !CYLINDRICAL_LIST.includes(cylindrical))
    return `${at}: detect.cylindrical must be one of ${CYLINDRICAL_LIST.join(', ')}`;
  return null;
}

function connectionProblem(id: string, group: unknown): string | null {
  const at = `prototype.connections['${id}']`;
  if (!isRecord(group) || group['id'] !== id) return `${at} must be an object whose id is '${id}'`;
  if (typeof group['name'] !== 'string') return `${at}: name must be a string`;
  if (typeof group['kind'] !== 'string' || !CONNECTION_KIND_LIST.includes(group['kind']))
    return `${at}: kind must be one of ${CONNECTION_KIND_LIST.join(', ')}`;
  if (typeof group['reason'] !== 'string' || group['reason'].trim().length === 0) return `${at}: reason must be non-empty`;
  if (group['declaredBy'] !== 'agent' && group['declaredBy'] !== 'user') return `${at}: declaredBy must be 'agent' or 'user'`;
  return membersProblem(at, group['members']) ?? detectProblem(at, group['detect']);
}

function connectionsProblems(value: unknown): string[] {
  if (value === undefined) return [];
  if (!isRecord(value)) return ['prototype.connections must be an object keyed by connection id'];
  return Object.entries(value).flatMap(([id, group]) => {
    const problem = isReservedKey(id)
      ? `prototype.connections: id '${id}' is a reserved JavaScript property name`
      : connectionProblem(id, group);
    return problem === null ? [] : [problem];
  });
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
  appendAll(errors, [
    ...referencesProblems(value['references']),
    ...dispositionsProblems(value['dispositions']),
    ...connectionsProblems(value['connections']),
  ]);
  return errors;
}
