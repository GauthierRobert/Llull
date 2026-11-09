/** Quantity parameters of the space-environment commands: `{ value, unit }` converted once to the units the formulas use. */

import { convertValue, isUnitFailure } from '@lib/quantity';
import { z } from '@core/commands/schema';

export const quantitySchema = z.object({
  value: z.number().describe('Value in `unit`.'),
  unit: z.string().describe('Unit, e.g. "mm", "mm^2/s", "%", "d", "K".'),
});
export const sourcedQuantity = (what: string): z.ZodType<{ value: number; unit: string; source?: string | undefined }> =>
  z.object({
    value: z.number().describe(`${what}, value in \`unit\`.`),
    unit: z.string().describe('Unit.'),
    source: z
      .string()
      .optional()
      .describe('Where the value comes from (report, standard, analysis revision). Required for a design input.'),
  });

export interface Converted {
  readonly value: number;
}
export interface UnitProblem {
  readonly path: string;
  readonly message: string;
}

/** `{ value, unit }` in `unit`, or the problem when the value is not finite or the unit is unknown / of another dimension. */
export function convertTo(
  quantity: { readonly value: number; readonly unit: string },
  unit: string,
  path: string,
): Converted | UnitProblem {
  if (!Number.isFinite(quantity.value)) return { path, message: `${path}.value must be finite` };
  const converted = convertValue(quantity.value, quantity.unit, unit);
  if (isUnitFailure(converted)) return { path: `${path}.unit`, message: `${converted.message} (need a unit convertible to '${unit}')` };
  return converted;
}

export const isProblem = (value: Converted | UnitProblem): value is UnitProblem => 'message' in value;
