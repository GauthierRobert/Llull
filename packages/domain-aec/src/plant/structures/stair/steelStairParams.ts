/** add_steel_stair parameters. */

import { vec3, z } from '@core/commands/schema';
import { levelIdParam } from '../../../building/levelParams';
import { RULESET_NAMES } from '../rules/ruleTable';

export const stairParams = z.object({
  start: vec3('Middle of the foot of the first riser [x, y, z], DOCUMENT UNITS; z relative to the level elevation.'),
  angle: z.number().optional().describe('Plan direction of the climb in RADIANS from +X, counter-clockwise. Default 0.'),
  rise: z
    .number()
    .positive()
    .optional()
    .describe('Total rise from the foot to the top walking surface, DOCUMENT UNITS. Give rise or toSurfaceId.'),
  toSurfaceId: z
    .string()
    .optional()
    .describe('Slab, grating or platform assembly element id at the top: the rise is computed from its top.'),
  width: z
    .number()
    .positive()
    .optional()
    .describe('Clear width between the stringers, DOCUMENT UNITS. Default from the rulesets (800 mm with both).'),
  riserMax: z
    .number()
    .positive()
    .describe(
      'Largest riser height, DOCUMENT UNITS; the riser count is the smallest that respects it (no default: choose it for the active rulesets).',
    ),
  going: z.number().positive().describe('Tread depth (nosing to nosing), DOCUMENT UNITS.'),
  stringerProfile: z.string().optional().describe('Steel catalogue name of the stringers (list_steel_profiles). Default UPN200.'),
  tread: z
    .object({
      kind: z.enum(['grating', 'checker_plate']).describe('"grating" needs gratingType, "checker_plate" needs thickness.'),
      gratingType: z.string().optional().describe('Catalogue key from list_grating_types (kind "grating").'),
      thickness: z.number().positive().optional().describe('Plate thickness, DOCUMENT UNITS (kind "checker_plate").'),
    })
    .optional()
    .describe(
      'Tread and landing surface: { kind: "grating", gratingType } or { kind: "checker_plate", thickness }. Default grating 19-W-4 1-1/4x3/16.',
    ),
  landings: z
    .array(
      z.object({
        afterRiser: z
          .number()
          .int()
          .min(2)
          .describe('The landing follows this riser (counted from 1 at the bottom); each flight needs 2+ risers.'),
        length: z.number().positive().optional().describe('Landing length along the climb, DOCUMENT UNITS. Default landingLength.'),
      }),
    )
    .optional()
    .describe('Explicit landings, ascending. Exclusive with landingEvery.'),
  landingEvery: z
    .number()
    .positive()
    .optional()
    .describe(
      'Largest rise of one flight, DOCUMENT UNITS: the stair is split into ceil(rise / landingEvery) equal flights with a landing between them.',
    ),
  landingLength: z
    .number()
    .positive()
    .optional()
    .describe('Length of landings without their own length, DOCUMENT UNITS. Default max(width, 762 mm with osha_1910).'),
  railings: z.enum(['none', 'left', 'right', 'both']).optional().describe('Hand-rails, left / right of the climb direction. Default none.'),
  railingHeight: z
    .number()
    .positive()
    .optional()
    .describe('Top of the hand-rail above the nosing line, DOCUMENT UNITS. Default from the rulesets.'),
  rulesets: z.array(z.enum(RULESET_NAMES)).min(1).optional().describe('Rulesets that decide the unset values. Default both.'),
  levelId: levelIdParam.describe('Level of the foot. Default: the active level.'),
});

export type StairParams = z.output<typeof stairParams>;
