/** zod building blocks shared by the analysis set-up commands (and the thermal / thermo-mechanical lanes). */

import { z } from '@core/commands/schema';

export const quantitySchema = z.object({
  value: z.number().describe('Numeric value.'),
  unit: z.string().describe("Unit text of the 08 grammar, e.g. 'degC', 'K', 'W/(m^2*K)', 'W'."),
});

export const analysisIdSchema = z.string().describe('Id of the analysis (affected[0] of create_analysis, e.g. an-1.1).');

const STEP_KEY_MAX = 64;

/** The stored `stepKey` of a signed record (`@lib/replaySurvivors`, SIG-REPLAY): the key of the feature step that wrote it. */
export const stepKeySchema = z.string().min(1).max(STEP_KEY_MAX);

/** Load problems of an optional stored `stepKey` at `at` (the hand-written ledger validators): absent, or text of 1 to 64 characters. */
export function stepKeyProblems(value: unknown, at: string): string[] {
  return value === undefined || (typeof value === 'string' && value !== '' && value.length <= STEP_KEY_MAX)
    ? []
    : [`${at}.stepKey must be text of at most ${STEP_KEY_MAX} characters`];
}
