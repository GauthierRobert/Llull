/**
 * Parameter schema of add_portal_frame_building.
 * @layer domain-aec
 */

import { z } from '@core/commands/schema';

export const portalFrameParams = z.object({
  origin: z.array(z.number()).optional().describe('Corner (gridline A1) [x, y]. Default [0, 0].'),
  span: z.number().optional().describe('Clear span between column axes (X). Default 24000 mm.'),
  spans: z
    .array(z.number())
    .optional()
    .describe(
      'Multi-span hall: widths of side-by-side spans along X (internal columns on shared lines, ' +
        'valley between roofs). Overrides span.',
    ),
  length: z.number().optional().describe('Hall length (Y). Default 48000 mm.'),
  baySpacing: z
    .number()
    .optional()
    .describe('Target frame spacing; adjusted to divide the length. Default 6000 mm.'),
  eaveHeight: z.number().optional().describe('Column height to the eaves. Default 7000 mm.'),
  roofPitch: z.number().optional().describe('Roof slope in degrees. Default 6.'),
  roofType: z
    .enum(['duopitch', 'monopitch'])
    .optional()
    .describe(
      "Roof shape: 'duopitch' (default: ridge mid-span, eaveHeight at both column lines) or 'monopitch' " +
        '(one rafter per span rising at roofPitch from the low eaves at the left (x = origin, height eaveHeight) ' +
        'to the high eaves on the right; the columns get different heights, with several spans the slope ' +
        'continues across the internal column lines; no apex connection, two eaves connections per frame; wind ' +
        'with EN 1991-1-4 Tab. 7.3a monopitch coefficients).',
    ),
  columnProfile: z.string().optional().describe('Default HEA400.'),
  rafterProfile: z.string().optional().describe('Default IPE450.'),
  purlinProfile: z.string().optional().describe('Default C200x75x2.5.'),
  railProfile: z
    .string()
    .optional()
    .describe('Side rails. Default C200x75x2.5 (passes check_purlins at qp 0.6 on 6 m bays).'),
  braceProfile: z.string().optional().describe('Bracing. Default CHS76.1x3.6.'),
  gablePostProfile: z.string().optional().describe('Gable wind posts. Default HEA200.'),
  purlinSpacing: z.number().optional().describe('Along the slope. Default 1800 mm.'),
  railSpacing: z.number().optional().describe('Vertical. Default 1800 mm.'),
  footings: z.boolean().optional().describe('Pad footings under columns. Default true.'),
  connections: z
    .boolean()
    .optional()
    .describe('Bolted end-plate moment connections (haunched eaves, apex). Default true.'),
  basePlates: z
    .boolean()
    .optional()
    .describe('Base plates with 4 M24 anchor bolts under every column. Default true.'),
  columnBase: z
    .enum(['pinned', 'fixed'])
    .optional()
    .describe(
      "Column base fixity: 'pinned' (default) or 'fixed' (rotation restrained in the frame analysis: " +
        'stiffer sway, base moments in the reactions and footing / base plate M+N checks; requires basePlates; ' +
        'size the plates with design_portal_frames).',
    ),
  cladding: z.boolean().optional().describe('Roof, side and gable cladding. Default true.'),
  floorSlab: z.boolean().optional().describe('Ground-bearing slab. Default true.'),
  crane: z
    .object({
      capacity: z.number().optional().describe('Tonnes. Default 10.'),
      railHeight: z.number().describe('Top of runway beam (must be below the eaves).'),
      profile: z.string().optional().describe('Runway section. Default HEB300.'),
    })
    .optional()
    .describe('Optional crane runway on both sides: { capacity (t), railHeight, profile }.'),
  levelId: z.string().optional().describe('Level id. Default: the active level.'),
});
