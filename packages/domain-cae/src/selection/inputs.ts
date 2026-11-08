/** Params shared by the selection commands and their validation (a bad value is a coded refusal, never a throw). */

import { z } from '@core/commands/schema';
import { convertValue, isUnitFailure } from '@lib/quantity';
import { PROPERTY_DIRECTIONS } from '@core/model/propertyModel';
import type { CadDocument } from '@core/model/types';
import type { ResolveOptions } from './properties';

export const quantitySchema = (what: string): z.ZodObject<{ value: z.ZodNumber; unit: z.ZodString }> =>
  z.object({
    value: z.number().describe(`${what}: value.`),
    unit: z.string().describe(`${what}: unit, e.g. 'mm', 'in', 'degC', 'K', 'MPa'.`),
  });

export const strengthSchema = z
  .enum(['Fty', 'Ftu', 'Fcy'])
  .describe(
    'Strength property of the strength indices: Fty (tensile yield), Ftu (tensile ultimate) or Fcy (compressive yield). No default: it changes the ranking.',
  );

export const directionSchema = z
  .enum(PROPERTY_DIRECTIONS)
  .describe("Grain / material direction of the values read (e.g. 'L'); an isotropic value answers any direction.");

export const thicknessSchema = quantitySchema('Product thickness').describe(
  'Product thickness, needed for values tabulated per thickness range (allowables); a value with a thickness band is ignored without it.',
);

export const temperatureSchema = quantitySchema('Operating temperature').describe(
  'Operating temperature: values are evaluated from their temperature laws (PHY-01) and a material whose law does not cover it is excluded with PROP_OUT_OF_RANGE, never extrapolated. Omit for room-temperature values.',
);

/** A problem with a quantity of the dimension of `reference` (a unit string), else null. */
export function quantityProblem(
  path: string,
  quantity: { readonly value: number; readonly unit: string },
  reference: string,
): string | null {
  if (!Number.isFinite(quantity.value)) return `${path}.value must be a finite number`;
  const converted = convertValue(quantity.value, quantity.unit, reference);
  return isUnitFailure(converted) ? `${path}.unit: ${converted.message}` : null;
}

interface CommonOptions {
  readonly direction?: ResolveOptions['direction'];
  readonly thickness?: ResolveOptions['thickness'];
  readonly temperature?: ResolveOptions['temperature'];
}

/** First problem of the thickness / temperature params, or null. */
export function optionsProblem(options: CommonOptions): string | null {
  return (
    (options.thickness === undefined ? null : quantityProblem('thickness', options.thickness, 'mm')) ??
    (options.temperature === undefined ? null : quantityProblem('temperature', options.temperature, 'K'))
  );
}

export const resolveOptionsOf = (options: CommonOptions): ResolveOptions => ({
  direction: options.direction,
  thickness: options.thickness,
  temperature: options.temperature,
});

/** The ids that are not materials of the document (own keys only). */
export const unknownMaterials = (doc: CadDocument, ids: readonly string[]): string[] =>
  ids.filter((id) => !Object.hasOwn(doc.materials, id));

/** Duplicates removed, first occurrence kept (deterministic request order). */
export const unique = <T>(values: readonly T[]): T[] => [...new Set(values)];
