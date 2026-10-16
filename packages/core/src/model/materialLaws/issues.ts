/** Issue vocabulary of the material-law validators (TECHNICAL_SPEC §7.1) and the checks shared by every law family. */

import { isUnitFailure, parseUnit, sameDimension } from '../../lib/quantity';
import type { LawParameter, MaterialValidRange } from '../materialModel';
import type { PropertyRecord } from '../propertyModelEval';
import { KERNEL_UNIT, convertQuantity, isLawFailure, type ParamDimension } from './resolve';

export interface MatlIssue {
  readonly code: string;
  readonly severity: 'error' | 'warning' | 'info';
  readonly path: string;
  readonly message: string;
}

export interface ValidateContext {
  /** The material the model hangs off: referenced property models are looked up here. */
  readonly record: PropertyRecord;
  /** Validity ranges of the model envelope (used by the Drucker severity). */
  readonly validity?: readonly MaterialValidRange[];
}

export const error = (code: string, path: string, message: string): MatlIssue => ({ code, severity: 'error', path, message });
export const warning = (code: string, path: string, message: string): MatlIssue => ({ code, severity: 'warning', path, message });
export const invalid = (path: string, message: string): MatlIssue => error('MATL_LAW_PARAMS_INVALID', path, message);

/** Value of a constant parameter in kernel units, or null for a property-model reference / a unit failure. */
export function constantValue(parameter: LawParameter, dimension: ParamDimension): number | null {
  if ('propertyModelId' in parameter) return null;
  const value = convertQuantity(parameter.value, parameter.unit, dimension, '');
  return isLawFailure(value) ? null : value;
}

/** Shape / unit problems of one parameter (finite value, unit of the right dimension, referenced model exists with such a unit). */
export function parameterIssues(parameter: LawParameter, dimension: ParamDimension, path: string, context: ValidateContext): MatlIssue[] {
  if ('propertyModelId' in parameter) {
    const model = context.record.propertyModels?.find((candidate) => candidate.id === parameter.propertyModelId);
    if (model === undefined)
      return [invalid(`${path}.propertyModelId`, `material '${context.record.name}' has no property model '${parameter.propertyModelId}'`)];
    const unit = parseUnit(model.unit);
    const expected = parseUnit(KERNEL_UNIT[dimension]);
    if (isUnitFailure(unit) || isUnitFailure(expected) || !sameDimension(unit.dimension, expected.dimension))
      return [
        invalid(`${path}.propertyModelId`, `property model '${model.id}' is in '${model.unit}', expected a unit of dimension ${dimension}`),
      ];
    return [];
  }
  if (!Number.isFinite(parameter.value)) return [invalid(`${path}.value`, 'must be a finite number')];
  const converted = convertQuantity(parameter.value, parameter.unit, dimension, path);
  return isLawFailure(converted) ? [invalid(`${path}.unit`, converted.message)] : [];
}

/** Every `{ value, unit }` leaf of a law must carry a parseable unit (catches typos in durability variants too). */
export function unitIssues(value: unknown, path: string): MatlIssue[] {
  if (Array.isArray(value)) return value.flatMap((item, i) => unitIssues(item, `${path}[${i}]`));
  if (typeof value !== 'object' || value === null) return [];
  const record = value as Record<string, unknown>;
  if (typeof record['value'] === 'number' && typeof record['unit'] === 'string') {
    const unit = parseUnit(record['unit']);
    return isUnitFailure(unit) ? [invalid(`${path}.unit`, unit.message)] : [];
  }
  return Object.entries(record).flatMap(([key, child]) => unitIssues(child, `${path}.${key}`));
}

export const positiveNumber = (value: number, path: string, label: string): MatlIssue[] =>
  Number.isFinite(value) && value > 0 ? [] : [invalid(path, `${label} must be a finite number > 0, got ${String(value)}`)];

export const nonNegativeNumber = (value: number, path: string, label: string): MatlIssue[] =>
  Number.isFinite(value) && value >= 0 ? [] : [invalid(path, `${label} must be a finite number ≥ 0, got ${String(value)}`)];

/** Constant parameter checked against a sign rule after its shape check. */
export function signedParameterIssues(
  parameter: LawParameter,
  dimension: ParamDimension,
  path: string,
  context: ValidateContext,
  rule: 'positive' | 'nonNegative',
): MatlIssue[] {
  const shape = parameterIssues(parameter, dimension, path, context);
  if (shape.length > 0) return shape;
  const value = constantValue(parameter, dimension);
  if (value === null) return [];
  return rule === 'positive' ? positiveNumber(value, `${path}.value`, 'value') : nonNegativeNumber(value, `${path}.value`, 'value');
}
