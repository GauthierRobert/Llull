/** The reliability study options as zod schemas: one definition shared by the command params and the load validation of a stored acceptance study. */

import { z } from '@core/commands/schema';

export const RESULT_METHODS = ['form', 'sorm', 'mc', 'is', 'fosm'] as const;
const SAMPLING_SCHEMES = ['mc', 'lhs', 'lhs_centred'] as const;
const MAX_FORM_ITERATIONS = 1000;

export const resultMethodsSchema = z.array(z.enum(RESULT_METHODS)).min(1).max(RESULT_METHODS.length);
export const samplingSchema = z.enum(SAMPLING_SCHEMES);
export const maxIterationsSchema = z.number().int().min(1).max(MAX_FORM_ITERATIONS);
/** Finite and positive (zod rejects Infinity). */
export const toleranceSchema = z.number().positive();

/** A stored acceptance `study` (types.ts `ResultStudy`): the same bounds as the params, so a file cannot ask a re-run for more work than a command can. */
const resultStudySchema = z.strictObject({
  methods: resultMethodsSchema,
  sampling: samplingSchema.optional(),
  maxIterations: maxIterationsSchema.optional(),
  tolerance: toleranceSchema.optional(),
});

export const isValidResultStudy = (study: unknown): boolean => resultStudySchema.safeParse(study).success;
