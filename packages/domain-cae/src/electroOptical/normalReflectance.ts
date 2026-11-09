/** normal_reflectance (PHY-15 FR-EOP-09): Fresnel reflectance at normal incidence and lossless slab transmittance, from caller-given refractive indices. */

import { defineCommand, z } from '@core/commands/schema';
import { report } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { refuseEop } from './codes';
import { normalReflectance as fresnel, slabTransmittance } from './physics';

/**
 * @affects nothing; read-only, document returned unchanged, affected: []
 * @invariant R = ((n1 - n2)^2 + k^2) / ((n1 + n2)^2 + k^2); slab T = (1 - R) / (1 + R) only for a lossless slab (k = 0, incoherent multiple reflections); n1 and k are required (no defaults);
 *   n2 and k are the caller's: the catalogue has no refractiveIndex model yet (it needs a wavelength variable), so a material is not accepted and the values are reported unverified
 * @failure n1 or n2 not finite and >= 1 for a lossless medium (n2 > 0 with k), negative k -> EOP_PARAMS_INVALID (refusal, unchanged doc)
 */
export const normalReflectance = defineCommand({
  name: 'normal_reflectance',
  annotations: { readOnly: true, idempotent: true },
  description:
    'Normal-incidence Fresnel reflectance of an interface R = ((n1 - n2)^2 + k^2) / ((n1 + n2)^2 + k^2) and, for a lossless slab (k = 0), the transmittance T = (1 - R) / (1 + R) (incoherent multiple reflections). ' +
    'The refractive indices are YOURS: give n2 (and k, the extinction coefficient, for an absorbing medium) valid at the wavelength you care about; llull has no refractive-index data and no material lookup. n1 (1 for air / vacuum) and k (0 for a lossless medium) are REQUIRED: there are no defaults. ' +
    'Returns data { R, slabT?, n1, n2, k, formula, wavelength?, unverified, unverifiedReasons }.',
  params: z.object({
    n2: z.number().describe('Refractive index of the second medium (>= 1 for a lossless dielectric), valid at your wavelength.'),
    k: z.number().describe('REQUIRED. Extinction coefficient of the second medium (>= 0): 0 for a lossless medium.'),
    n1: z.number().describe('REQUIRED. Refractive index of the first medium (1 for air / vacuum).'),
    wavelength: z
      .object({ value: z.number().describe('Wavelength.'), unit: z.string().describe("Unit, e.g. 'nm'.") })
      .optional()
      .describe('Wavelength the indices are valid at: recorded in the result only, it does not change R.'),
  }),
  run: (doc, { n2, k, n1, wavelength }): CommandResult => {
    const fail = (message: string, path: string): CommandResult =>
      refuseEop(doc, 'normal_reflectance', 'EOP_PARAMS_INVALID', message, [], [path]);
    const first = n1;
    const extinction = k;
    if (!Number.isFinite(first) || !(first >= 1)) return fail('n1 must be finite and >= 1', 'n1');
    if (!Number.isFinite(n2) || !(n2 > 0) || (extinction === 0 && !(n2 >= 1)))
      return fail('n2 must be finite and at least 1 for a lossless medium, above 0 for an absorbing one', 'n2');
    if (!Number.isFinite(extinction) || extinction < 0) return fail('k must be finite and >= 0', 'k');
    const reflectance = fresnel(first, n2, extinction);
    const lossless = extinction === 0;
    const slab = lossless ? slabTransmittance(reflectance) : undefined;
    return report(
      doc,
      `normal_reflectance: R = ${reflectance.toPrecision(8)} for n1 ${first}, n2 ${n2}${slab === undefined ? `, k ${extinction} (slab transmittance needs a lossless medium)` : `; lossless slab T = ${slab.toPrecision(8)}`}.`,
      {
        R: reflectance,
        ...(slab === undefined ? {} : { slabT: slab }),
        n1: first,
        n2,
        k: extinction,
        formula: 'R = ((n1 - n2)^2 + k^2) / ((n1 + n2)^2 + k^2); lossless slab T = (1 - R) / (1 + R)',
        ...(wavelength === undefined ? {} : { wavelength }),
        unverified: true,
        unverifiedReasons: ['EOP_VALUE_UNSOURCED: the refractive indices were supplied by the caller without a record'],
      },
    );
  },
});
