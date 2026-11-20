/** zod building blocks shared by the analysis set-up commands (and the thermal / thermo-mechanical lanes). */

import { z } from '@core/commands/schema';

export const quantitySchema = z.object({
  value: z.number().describe('Numeric value.'),
  unit: z.string().describe("Unit text of the 08 grammar, e.g. 'degC', 'K', 'W/(m^2*K)', 'W'."),
});

export const analysisIdSchema = z.string().describe('Id of the analysis (affected[0] of create_analysis, e.g. an-1.1).');

/** The stored `stepKey` of a signed record (`@lib/replaySurvivors`, SIG-REPLAY): the key of the feature step that wrote it. */
export const stepKeySchema = z.string().min(1).max(64);
