/** One calculation input with its provenance: a caller-supplied value (sourced when `source` is given) or a material record value (PHY-01). */

import { convertTo, isProblem, type UnitProblem } from './units';
import type { MaterialMissing, MaterialValue } from './materialValue';

export interface ResolvedInput {
  readonly value: number;
  readonly unit: string;
  readonly source: string | undefined;
  readonly unverified: boolean;
}

export interface GivenQuantity {
  readonly value: number;
  readonly unit: string;
  readonly source?: string | undefined;
}

/** A caller-supplied quantity converted to `unit`; without `source` it is flagged unverified. */
export function givenInput(quantity: GivenQuantity, unit: string, path: string): ResolvedInput | UnitProblem {
  const converted = convertTo(quantity, unit, path);
  if (isProblem(converted)) return converted;
  const source = quantity.source === undefined || quantity.source.trim() === '' ? undefined : quantity.source;
  return { value: converted.value, unit, source, unverified: source === undefined };
}

/** A material value as an input. */
export const materialInput = (value: MaterialValue): ResolvedInput => ({
  value: value.value,
  unit: value.unit,
  source: value.source,
  unverified: value.unverified,
});

export const isInputProblem = (value: ResolvedInput | UnitProblem | MaterialMissing): value is UnitProblem | MaterialMissing =>
  'message' in value || 'reason' in value;

/** The `data.inputs` record shape: value, unit and where it came from. */
export const describeInput = (input: ResolvedInput): { value: number; unit: string; source?: string; unverified: boolean } => ({
  value: input.value,
  unit: input.unit,
  ...(input.source === undefined ? {} : { source: input.source }),
  unverified: input.unverified,
});
