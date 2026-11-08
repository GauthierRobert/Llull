/** zod pieces of the contact-pair commands (PHY-06 §4): behaviour, friction, adjust, formulation. */

import type { ContactBehaviour } from '@core/model/contact';
import { z } from '@core/commands/schema';

export const formulationSchema = z
  .enum(['node_to_surface', 'surface_to_surface', 'mortar'])
  .describe(
    'CalculiX *CONTACT PAIR TYPE: node_to_surface (slave nodes on master faces), surface_to_surface (penalty, small sliding by default), ' +
      'mortar. ONE formulation per analysis (CalculiX rule): the first pair fixes it.',
  );

export const behaviourSchema = z
  .discriminatedUnion('kind', [
    z.object({
      kind: z
        .literal('hard')
        .describe('Hard contact: CalculiX penalty defaults (node_to_surface / surface_to_surface), true hard for mortar.'),
    }),
    z.object({
      kind: z.literal('linear').describe('Linear penalty pressure-overclosure.'),
      slope: z
        .number()
        .describe('Penalty stiffness K, stress per length of the analysis unit system (N-mm-t-s: MPa/mm), > 0; ~5-50 x E is usual.'),
      tensionAtLargeClearance: z
        .number()
        .optional()
        .describe('sigma_inf, stress of the analysis unit system (> 0); CalculiX default when absent.'),
      c0: z.number().optional().describe('c0, analysis length (> 0; surface_to_surface); CalculiX default when absent.'),
    }),
    z.object({
      kind: z.literal('exponential').describe('Exponential pressure-overclosure.'),
      c0: z.number().describe('Clearance at which pressure starts, analysis length (> 0).'),
      p0: z.number().describe('Pressure at zero clearance, analysis stress (> 0).'),
    }),
    z.object({
      kind: z.literal('tied').describe('Tied (glued) faces, surface_to_surface only: supersedes the 05 tied-contact hook.'),
      slope: z.number().describe('Normal penalty stiffness, analysis stress per length (> 0).'),
      stickSlope: z.number().describe('Tangential stiffness (CalculiX *FRICTION stick slope), analysis stress per length (> 0).'),
    }),
  ])
  .describe('Pressure-overclosure behaviour (CalculiX *SURFACE BEHAVIOR).');

export const frictionSchema = z
  .object({
    mu: z.number().describe('Coulomb friction coefficient (> 0).'),
    stickSlope: z
      .number()
      .optional()
      .describe(
        'Stick slope lambda, analysis stress per length (> 0); absent = CalculiX default (first elastic constant / 2), reported as a named default.',
      ),
  })
  .describe('Coulomb friction (CalculiX *FRICTION); not allowed on tied pairs.');

export const adjustSchema = z
  .discriminatedUnion('kind', [
    z.object({
      kind: z.literal('clearance').describe('Move slave nodes closer than value onto the master at the start (ADJUST=value).'),
      value: z.number().describe('Clearance, document length units (> 0).'),
    }),
    z.object({ kind: z.literal('none').describe('No initial adjustment.') }),
  ])
  .describe('Initial adjustment of the slave nodes (*CONTACT PAIR ADJUST).');

/** Plain `ContactBehaviour` from validated input (absent optional values omitted, never undefined). */
export function toBehaviour(input: z.output<typeof behaviourSchema>): ContactBehaviour {
  if (input.kind !== 'linear') return input;
  return {
    kind: 'linear',
    slope: input.slope,
    ...(input.tensionAtLargeClearance !== undefined ? { tensionAtLargeClearance: input.tensionAtLargeClearance } : {}),
    ...(input.c0 !== undefined ? { c0: input.c0 } : {}),
  };
}
