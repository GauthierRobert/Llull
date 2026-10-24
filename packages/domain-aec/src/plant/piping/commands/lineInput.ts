/** Params and checks shared by `create_pipeline` and `update_pipeline`: insulation request and declared slope. */

import { z } from '@core/commands/schema';
import { validSlope } from '../slope';
import { slopeInput } from './routeInput';

export const insulationInput = z.object({
  code: z.string().min(1).describe("Insulation code written in the line number, e.g. 'H' (hot)."),
  thickness: z
    .union([z.number().positive(), z.literal('fromSpec')])
    .describe(
      'Thickness in mm, or "fromSpec" to read the spec insulation table (needs designTempC and a table row for the code, DN and temperature).',
    ),
  material: z.string().min(1).optional().describe('Insulation material; default from the spec table row, else unnamed.'),
});

export const lineSlopeInput = slopeInput.describe(
  'Declared slope of the whole line (a gravity drain): check_piping reports legs that rise against it (RTE_ADVERSE_SLOPE) and low / high points without a drain / vent (RTE_POCKET).',
);

/** True when `slope` is a usable declaration (> 0 and at most 45 degrees). */
export const slopeProblem = (slope: z.infer<typeof slopeInput>): string | null =>
  validSlope(slope) ? null : `slope ${slope.value} ${slope.unit} must be > 0 and at most 45 degrees (100 %)`;
