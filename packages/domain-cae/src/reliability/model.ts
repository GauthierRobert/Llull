/** Access to and validation of the probabilistic slice of the document (`CadDocument.probabilistic`, plugin `cae`). */

import type { CadDocument } from '@core/model/types';
import type { LimitState, RandomVariable, ReliabilityModel } from '@core/model/probabilistic';
import { isRecord } from '@lib/isRecord';
import { distributionIssue } from './distributions';
import { cholesky } from './numerics';

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
  if (!isRecord(binding) || (binding['kind'] !== 'free' && !(binding['kind'] === 'parameter' && isString(binding['parameter']))))
    return bad('has a malformed binding');
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
  return [...errors, ...correlationErrors(slice['correlation'], variables)];
}
