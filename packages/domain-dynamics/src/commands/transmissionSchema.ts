/** add_transmission parameters. */

import { z } from '@core/commands/schema';
import { sourceSchema } from './motorSchemas';

export const transmissionParams = z.object({
  kind: z.enum(['gear', 'belt', 'lead_screw', 'ball_screw', 'rack_pinion']).describe('Transmission kind.'),
  driver: z.string().optional().describe('gear, belt: revolute joint id that drives (the input).'),
  driven: z.string().optional().describe('gear, belt: revolute joint id that follows.'),
  ratio: z
    .number()
    .optional()
    .describe('gear: speed(driven) / speed(driver), negative reverses. Give this OR `teeth`; with both they must agree.'),
  teeth: z
    .tuple([z.number().int().positive(), z.number().int().positive()])
    .optional()
    .describe('gear: tooth counts [driver, driven]: ratio = driverTeeth / drivenTeeth (negated by `reverseRotation`).'),
  reverseRotation: z
    .boolean()
    .optional()
    .describe('gear with `teeth`: true for an external spur mesh (driven turns the other way). Default false.'),
  driverDiameterMm: z.number().optional().describe('belt: driver pulley pitch diameter, mm (> 0).'),
  drivenDiameterMm: z.number().optional().describe('belt: driven pulley pitch diameter, mm (> 0).'),
  screw: z.string().optional().describe('lead_screw, ball_screw: revolute joint id of the screw (the input).'),
  nut: z.string().optional().describe('lead_screw, ball_screw: prismatic joint id of the nut.'),
  pinion: z.string().optional().describe('rack_pinion: revolute joint id of the pinion (the input).'),
  rack: z.string().optional().describe('rack_pinion: prismatic joint id of the rack.'),
  leadMm: z
    .number()
    .optional()
    .describe('screws: advance of the nut per screw revolution, mm (> 0); the positive screw sense advances the nut along its joint axis.'),
  meanDiameterMm: z.number().optional().describe('lead_screw: mean thread diameter d_m, mm (> 0).'),
  mu: z
    .number()
    .optional()
    .describe(
      'lead_screw: coefficient of friction of the thread flanks (>= 0): steel on bronze 0.08-0.15 lubricated, 0.35 dry steel on steel.',
    ),
  flankAngleDeg: z.number().optional().describe('lead_screw: flank half-angle α_n in degrees, [0, 90). Default 0 (square thread).'),
  pitchRadiusMm: z.number().optional().describe('rack_pinion: pitch radius of the pinion, mm (> 0).'),
  efficiency: z
    .number()
    .optional()
    .describe(
      'gear, belt, ball_screw, rack_pinion: forward efficiency in (0, 1]. gear / belt / rack default 1 (ideal); required for ball_screw.',
    ),
  efficiencyBack: z
    .number()
    .optional()
    .describe('gear, rack_pinion, ball_screw: back-drive efficiency in (0, 1]. Default = efficiency (required for ball_screw).'),
  backlashDeg: z.number().optional().describe('gear: total angular gap at the driven shaft, degrees (> 0).'),
  backlashMm: z.number().optional().describe('rack_pinion: total linear gap of the rack, mm (> 0).'),
  meshStiffnessNmPerRad: z.number().optional().describe('gear with backlash: contact stiffness at the driven shaft, N·m/rad (> 0).'),
  meshStiffnessNPerM: z.number().optional().describe('rack_pinion with backlash: contact stiffness at the rack, N/m (> 0).'),
  meshDampingRatio: z.number().optional().describe('gear / rack_pinion with backlash: damping ratio of the contact (> 0, default 0.5).'),
  source: sourceSchema.optional().describe('Where the efficiencies / geometry come from (recommended: grades the result).'),
  id: z.string().optional().describe('Optional explicit transmission id.'),
});
