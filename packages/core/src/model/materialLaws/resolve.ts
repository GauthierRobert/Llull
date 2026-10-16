/**
 * Resolution of law parameters to numbers (TECHNICAL_SPEC TR-MATL-12): constants are converted to the kernel unit system
 * (MPa, K, s, 1/MPa); `{ propertyModelId }` parameters are evaluated through PHY-01 `evaluatePropertyModel` and its refusal codes
 * (PROP_OUT_OF_RANGE, PROP_VARIABLE_MISSING …) are passed through unchanged.
 */

import { convertValue, isUnitFailure } from '../../lib/quantity';
import { evaluatePropertyModel, type PropertyRecord, type VariableValues } from '../propertyModelEval';
import type { LawParameter } from '../materialModel';

/** Failure of a resolution / validation step, carrying a stable code (MATL_* or a passed-through PROP_* / MAT_* code). */
export interface LawFailure {
  readonly code: string;
  readonly message: string;
  readonly path: string;
  readonly remediation?: string;
}

export const isLawFailure = (value: unknown): value is LawFailure =>
  typeof value === 'object' && value !== null && 'code' in value && 'message' in value && 'path' in value;

export type ParamDimension = 'stress' | 'inverseStress' | 'dimensionless' | 'temperature' | 'time' | 'energyPerMole' | 'rate';

/** Kernel unit of each dimension. */
export const KERNEL_UNIT: Readonly<Record<ParamDimension, string>> = {
  stress: 'MPa',
  inverseStress: '1/MPa',
  dimensionless: '1',
  temperature: 'K',
  time: 's',
  energyPerMole: 'J/mol',
  rate: '1/s',
};

/** What the state of a resolution accumulates: models read, reasons their values are unverified, whether a human review is pending. */
export interface ResolutionTrace {
  readonly propertyModelIds: Set<string>;
  readonly unverifiedReasons: Set<string>;
  reviewRequired: boolean;
}

export const newTrace = (): ResolutionTrace => ({ propertyModelIds: new Set(), unverifiedReasons: new Set(), reviewRequired: false });

export interface ResolveEnv {
  readonly record: PropertyRecord;
  /** Operating point handed to referenced property models (e.g. { T }). */
  readonly at: VariableValues;
  readonly trace: ResolutionTrace;
}

export const failure = (code: string, path: string, message: string, remediation?: string): LawFailure => ({
  code,
  path,
  message,
  ...(remediation !== undefined ? { remediation } : {}),
});

/** Convert a quantity to the kernel unit of `dimension`. */
export function convertQuantity(value: number, unit: string, dimension: ParamDimension, path: string): number | LawFailure {
  const converted = convertValue(value, unit, KERNEL_UNIT[dimension]);
  return isUnitFailure(converted)
    ? failure(
        'MATL_LAW_PARAMS_INVALID',
        path,
        converted.message,
        `give '${path}' a unit of dimension ${dimension} (e.g. '${KERNEL_UNIT[dimension]}')`,
      )
    : converted.value;
}

export function resolveParameter(parameter: LawParameter, dimension: ParamDimension, env: ResolveEnv, path: string): number | LawFailure {
  if (!('propertyModelId' in parameter)) return convertQuantity(parameter.value, parameter.unit, dimension, path);
  const id = parameter.propertyModelId;
  const model = env.record.propertyModels?.find((candidate) => candidate.id === id);
  if (model === undefined) {
    return failure(
      'PROP_MODEL_NOT_FOUND',
      `${path}.propertyModelId`,
      `material '${env.record.name}' has no property model '${id}'`,
      'define it with define_property_model',
    );
  }
  const evaluation = evaluatePropertyModel(env.record, model, env.at);
  if (!evaluation.available) {
    return failure(evaluation.code, `${path}.propertyModelId`, evaluation.reason, evaluation.remediation);
  }
  env.trace.propertyModelIds.add(id);
  for (const reason of evaluation.unverifiedReasons) env.trace.unverifiedReasons.add(`property model '${id}': ${reason}`);
  if (evaluation.reviewRequired) env.trace.reviewRequired = true;
  return convertQuantity(evaluation.value, evaluation.unit, dimension, path);
}

/** Resolve a list of parameters; the first failure wins. */
export function resolveAll<K extends string>(
  entries: Readonly<Record<K, { readonly parameter: LawParameter; readonly dimension: ParamDimension }>>,
  env: ResolveEnv,
  pathPrefix: string,
): Record<K, number> | LawFailure {
  const result = {} as Record<K, number>;
  for (const key of Object.keys(entries) as K[]) {
    const entry = entries[key];
    const value = resolveParameter(entry.parameter, entry.dimension, env, `${pathPrefix}.${key}`);
    if (isLawFailure(value)) return value;
    result[key] = value;
  }
  return result;
}
