/** Access to and validation of the probabilistic slice of the document (`CadDocument.probabilistic`, plugin `cae`). */

import type { CadDocument } from '@core/model/types';
import type { LimitState, RandomVariable, ReliabilityModel, Response } from '@cae/reliability/types';
import { isRecord } from '@lib/isRecord';
import { isReservedKey } from '@lib/reservedKey';
import { distributionIssue } from './distributions';
import { cholesky } from '@lib/denseLinalg';

const EMPTY: ReliabilityModel = { variables: {}, variableOrder: [], limitStates: {}, limitStateOrder: [] };

export const reliabilityOf = (doc: CadDocument): ReliabilityModel => doc.probabilistic ?? EMPTY;

export const withReliability = (doc: CadDocument, model: ReliabilityModel): CadDocument => ({ ...doc, probabilistic: model });

export const variableOf = (doc: CadDocument, name: string): RandomVariable | undefined => {
  const { variables } = reliabilityOf(doc);
  return Object.hasOwn(variables, name) ? variables[name] : undefined;
};

export const limitStateOf = (doc: CadDocument, name: string): LimitState | undefined => {
  const { limitStates } = reliabilityOf(doc);
  return Object.hasOwn(limitStates, name) ? limitStates[name] : undefined;
};

const isTarget = (value: unknown): boolean =>
  value === undefined || (isRecord(value) && typeof value['value'] === 'number' && typeof value['source'] === 'string');

const isString = (value: unknown): value is string => typeof value === 'string';

function variableErrors(name: string, variable: unknown): string[] {
  const bad = (why: string): string[] => [`random variable '${name}': ${why}`];
  if (!isRecord(variable) || variable['name'] !== name || !isString(variable['id']) || !isString(variable['unit']))
    return bad('is malformed');
  const distribution = variable['distribution'];
  if (!isRecord(distribution)) return bad('has no distribution');
  const issue = distributionIssue(distribution as unknown as RandomVariable['distribution']);
  if (issue !== null) return bad(issue);
  const binding = variable['binding'];
  const bound =
    isRecord(binding) &&
    (binding['kind'] === 'free' ||
      (binding['kind'] === 'parameter' && isString(binding['parameter'])) ||
      (binding['kind'] === 'materialProperty' && isString(binding['material']) && isString(binding['property'])));
  if (!bound) return bad('has a malformed binding');
  const derived = variable['derivedFrom'];
  if (derived !== undefined && !(isRecord(derived) && isString(derived['modelId']) && typeof derived['value'] === 'number'))
    return bad('has a malformed derivedFrom');
  const citation = variable['citation'];
  if (citation !== undefined && !(isRecord(citation) && isString(citation['text']))) return bad('has a malformed citation');
  return [];
}

function correlationErrors(correlation: unknown, variables: Record<string, unknown>): string[] {
  if (correlation === undefined) return [];
  const bad = [
    'probabilistic.correlation is malformed (names must be defined variables, matrix square, symmetric, unit diagonal, positive definite)',
  ];
  if (!isRecord(correlation)) return bad;
  const { names, matrix } = correlation;
  if (!Array.isArray(names) || !Array.isArray(matrix) || matrix.length !== names.length || names.length < 2) return bad;
  if (!names.every((n) => isString(n) && Object.hasOwn(variables, n)) || new Set(names).size !== names.length) return bad;
  const numeric = matrix.every((row) => Array.isArray(row) && row.length === names.length && row.every((v) => typeof v === 'number'));
  if (!numeric) return bad;
  const rows = matrix as number[][];
  const symmetric = rows.every((row, i) => row[i] === 1 && row.every((v, j) => Math.abs(v - (rows[j]?.[i] ?? Number.NaN)) <= 1e-12));
  return symmetric && cholesky(rows) !== null ? [] : bad;
}

export const responseOf = (doc: CadDocument, name: string): Response | undefined => {
  const responses = reliabilityOf(doc).responses ?? {};
  return Object.hasOwn(responses, name) ? responses[name] : undefined;
};

function acceptanceErrors(slice: Record<string, unknown>): string[] {
  const valid = (entry: unknown, limitState: boolean): boolean =>
    isRecord(entry) &&
    isString(entry['modelHash']) &&
    isString(entry['resultHash']) &&
    typeof entry['seed'] === 'number' &&
    typeof entry['samples'] === 'number' &&
    isString(entry['justification']) &&
    isString(entry['signer']) &&
    isString(entry['signatureId']) &&
    isString(entry['documentUid']) &&
    entry['signature'] !== undefined &&
    (!limitState || isString(entry['limitState']));
  const { acceptances, acceptanceLedger } = slice;
  const errors: string[] = [];
  if (acceptances !== undefined) {
    if (!isRecord(acceptances)) errors.push('probabilistic.acceptances must be an object');
    else
      for (const [name, entry] of Object.entries(acceptances))
        if (isReservedKey(name) || !Object.hasOwn(isRecord(slice['limitStates']) ? slice['limitStates'] : {}, name) || !valid(entry, false))
          errors.push(`acceptance '${name}' is malformed or names no limit state`);
  }
  if (acceptanceLedger !== undefined && (!Array.isArray(acceptanceLedger) || !acceptanceLedger.every((entry) => valid(entry, true))))
    errors.push('probabilistic.acceptanceLedger is malformed');
  return errors;
}

function responseErrors(slice: Record<string, unknown>): string[] {
  const { responses, responseOrder } = slice;
  if (responses === undefined && responseOrder === undefined) return [];
  if (!isRecord(responses) || !Array.isArray(responseOrder)) return ['probabilistic.responses / responseOrder are malformed'];
  const errors = Object.entries(responses).flatMap(([name, response]) => {
    const query = isRecord(response) ? response['query'] : undefined;
    return !isReservedKey(name) &&
      isRecord(response) &&
      response['name'] === name &&
      isString(response['id']) &&
      isString(response['unit']) &&
      isRecord(query) &&
      isString(query['command']) &&
      isRecord(query['params']) &&
      isString(query['pointer'])
      ? []
      : [`response '${name}' is malformed`];
  });
  if (responseOrder.some((n) => !isString(n) || !Object.hasOwn(responses, n)))
    errors.push('probabilistic.responseOrder names an unknown response');
  return errors;
}

/** Value errors of the raw `probabilistic` slice (persistence rejects the file when non-empty). */
export function reliabilityErrors(raw: Record<string, unknown>): string[] {
  const slice = raw['probabilistic'];
  if (slice === undefined) return [];
  if (!isRecord(slice)) return ['probabilistic must be an object'];
  const { variables, limitStates, variableOrder, limitStateOrder } = slice;
  if (!isRecord(variables) || !Array.isArray(variableOrder)) return ['probabilistic.variables / variableOrder are malformed'];
  if (!isRecord(limitStates) || !Array.isArray(limitStateOrder)) return ['probabilistic.limitStates / limitStateOrder are malformed'];
  const errors = Object.entries(variables).flatMap(([name, variable]) => variableErrors(name, variable));
  for (const [name, limitState] of Object.entries(limitStates))
    if (
      !isRecord(limitState) ||
      limitState['name'] !== name ||
      !isString(limitState['id']) ||
      !isString(limitState['expression']) ||
      !isString(limitState['unit']) ||
      !isTarget(limitState['targetBeta']) ||
      !isTarget(limitState['targetPf'])
    )
      errors.push(`limit state '${name}' is malformed`);
  if (variableOrder.some((n) => !isString(n) || !Object.hasOwn(variables, n)))
    errors.push('probabilistic.variableOrder names an unknown variable');
  if (limitStateOrder.some((n) => !isString(n) || !Object.hasOwn(limitStates, n)))
    errors.push('probabilistic.limitStateOrder names an unknown limit state');
  return [...errors, ...responseErrors(slice), ...acceptanceErrors(slice), ...correlationErrors(slice['correlation'], variables)];
}
