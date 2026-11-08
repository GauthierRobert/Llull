/** Input reading of `creep_closed_form`: a number in the unit of the key suffix, or `{ value, unit }` converted to it. */

import { convertValue, isUnitFailure } from '@lib/quantity';

/** One input: key, canonical unit (null: dimensionless / a plain number only). */
export interface InputSpec<K extends string = string> {
  readonly key: K;
  readonly unit: string | null;
  /** Lower bound check: `positive` > 0, `nonNegative` >= 0, `any` finite. */
  readonly sign: 'positive' | 'nonNegative' | 'any';
}

export interface InputProblem {
  readonly code: 'CRP_INPUT_MISSING' | 'CRP_INPUT_INVALID';
  readonly message: string;
  readonly key: string;
}

export const isInputProblem = (value: unknown): value is InputProblem => typeof value === 'object' && value !== null && 'code' in value;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The number of `spec.key` in `inputs`, in the spec unit.
 * @failure absent -> CRP_INPUT_MISSING (names the key and its unit); non-finite, wrong unit dimension or violated sign -> CRP_INPUT_INVALID
 */
export function inputValue(inputs: Readonly<Record<string, unknown>>, spec: InputSpec): number | InputProblem {
  const raw = Object.hasOwn(inputs, spec.key) ? inputs[spec.key] : undefined;
  const label = spec.unit === null ? spec.key : `${spec.key} (${spec.unit})`;
  if (raw === undefined) return { code: 'CRP_INPUT_MISSING', key: spec.key, message: `input ${label} is missing` };
  const invalid = (reason: string): InputProblem => ({ code: 'CRP_INPUT_INVALID', key: spec.key, message: `input ${label}: ${reason}` });
  let value: number;
  if (typeof raw === 'number') value = raw;
  else if (isRecord(raw) && typeof raw['value'] === 'number' && typeof raw['unit'] === 'string') {
    if (spec.unit === null) return invalid('is dimensionless: give a plain number');
    const converted = convertValue(raw['value'], raw['unit'], spec.unit);
    if (isUnitFailure(converted)) return invalid(converted.message);
    value = converted.value;
  } else return invalid(spec.unit === null ? 'must be a number' : `must be a number in ${spec.unit} or { value, unit }`);
  if (!Number.isFinite(value)) return invalid('must be finite');
  if (spec.sign === 'positive' && !(value > 0)) return invalid('must be > 0');
  if (spec.sign === 'nonNegative' && !(value >= 0)) return invalid('must be >= 0');
  return value;
}

/** Every spec read at once: the numbers by key, or the first problem. */
export function inputValues<K extends string>(
  inputs: Readonly<Record<string, unknown>>,
  specs: readonly InputSpec<K>[],
): Readonly<Record<K, number>> | InputProblem {
  const out = {} as Record<K, number>;
  for (const spec of specs) {
    const value = inputValue(inputs, spec);
    if (isInputProblem(value)) return value;
    out[spec.key] = value;
  }
  return out;
}
