/** zod building blocks shared by the fatigue commands. */

import { z } from '@core/commands/schema';
import type { FatigueFactors } from '@core/model/durability';
import { quantitySchema } from '../shared/schemas';

export const stressQuantity = quantitySchema.describe('A stress { value, unit } with a stress unit (MPa, ksi, psi, ...).');

export const meanStressSchema = z.union([
  z.enum(['none', 'goodman', 'gerber', 'soderberg', 'morrow', 'swt']),
  z.object({ walker: z.number().describe('Walker exponent gamma in (0, 1]; gamma 0.5 equals SWT.') }),
]);

export const MEAN_STRESS_TEXT =
  'Mean-stress correction: none | goodman (needs Ftu on the record) | gerber (Ftu) | soderberg (Fty) | morrow (sn_basquin sigma_f) | swt | ' +
  '{ walker: gamma }. A compressive mean gives no benefit for goodman / gerber / soderberg / morrow unless compressiveMean "formula".';

export const modifierSchema = z.object({
  name: z.enum(['surface', 'size', 'reliability', 'environment', 'other']).describe('Which Marin-type modifier this is.'),
  value: z.number().describe('Factor > 0 multiplying the curve strength (0.8 = 20 % weaker than the test specimen). Never defaulted.'),
  justification: z.string().describe('Mandatory reason / source of the factor.'),
});

export const notchSchema = z.object({
  kt: z.number().describe('Elastic stress concentration factor Kt >= 1.'),
  q: z.number().describe('Notch sensitivity q in [0, 1]: Kf = 1 + q (Kt - 1).'),
  feIncludesKt: z
    .boolean()
    .describe('true when the stress already contains the concentration (no extra Kf); false: Kf scales the nominal stress.'),
});

export const NOTCH_TEXT =
  'Optional notch: the nominal stress is scaled by Kf = 1 + q (Kt - 1) (Neuber on the cyclic curve for strain-life).';

/** Problem with a modifier / factor list, or null. */
export function modifierProblem(modifiers: FatigueFactors['modifiers']): string | null {
  const bad = modifiers.find((entry) => !(entry.value > 0) || !Number.isFinite(entry.value) || entry.justification.trim() === '');
  return bad === undefined ? null : `modifier '${bad.name}' needs a value > 0 and a justification`;
}

export const notchProblem = (notch: { readonly kt: number; readonly q: number }): string | null =>
  notch.kt >= 1 && notch.q >= 0 && notch.q <= 1 ? null : 'notch needs kt >= 1 and q in [0, 1]';
