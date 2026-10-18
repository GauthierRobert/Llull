/** cycling_power params (one schema for both models) and the refusal callback its model runners share. */

import { z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { airStateParams } from '../shared/airState';
import { speedParam } from '../shared/speed';
import { flowParams } from './geometryArea';

export const cyclingParams = z.object({
  model: z.enum(['martin_1998', 'bassett_1999']).optional().describe('martin_1998 (default, road) or bassett_1999 (track hour record).'),
  ...speedParam,
  powerW: z.number().optional().describe('Crank power in W (> 0); the command solves the steady speed. Give this or speed.'),
  massKg: z.number().optional().describe('martin: total mass rider + bicycle + kit in kg (> 0). Required.'),
  cdA: z.number().optional().describe('martin: drag area CdA in m² (> 0). Or cd + entityIds.'),
  cd: z.number().optional().describe('martin: drag coefficient on the frontal area of entityIds.'),
  entityIds: z
    .array(z.string())
    .optional()
    .describe('martin: rider + bicycle solids; frontal area along flowDirection (default [1, 0, 0]).'),
  ...flowParams,
  crr: z.number().optional().describe('martin: rolling resistance coefficient (default 0.0032, Martin 1998 road tyres).'),
  gradePercent: z.number().optional().describe('martin: road grade in % (rise / run × 100, -25..25). Default 0.'),
  headwindMS: z.number().optional().describe('martin: wind along the road in m/s, + headwind / - tailwind. Default 0.'),
  wheelAreaM2: z.number().optional().describe('martin: wheel rotation drag area Fw in m² (default 0.0044).'),
  chainEfficiency: z.number().optional().describe('martin: drivetrain efficiency E_c in (0, 1] (default 0.976).'),
  bearingLosses: z.boolean().optional().describe('martin: include wheel-bearing friction 91 + 8.7·V mW per m/s (default true).'),
  riderHeightM: z.number().optional().describe('bassett: rider height in m (1.4..2.2). Required.'),
  riderMassKg: z.number().optional().describe('bassett: rider mass in kg (40..120). Required.'),
  bikeMassKg: z.number().optional().describe('bassett: bicycle mass in kg (default 10, the paper value).'),
  k1: z.number().optional().describe('bassett: aerodynamic factor K1 = Kd·Kpo·Kb·Kc·Kh (overrides the factors below).'),
  positionFactor: z
    .number()
    .optional()
    .describe('bassett: Kpo (e.g. 1.0 aero bars, 0.95 Superman, 0.96 Obree, 1.08 drop bars). Default 1.'),
  bikeFactor: z.number().optional().describe('bassett: Kb (0.93 aero bike, 1.07 drop bars + spoked wheels). Default 1.'),
  clothingFactor: z.number().optional().describe('bassett: Kc (1.02-1.09 wool). Default 1.'),
  helmetFactor: z.number().optional().describe('bassett: Kh (1.025-1.04 no aero helmet). Default 1.'),
  trackFactor: z.number().optional().describe('bassett: K, external conditions (track roughness). Default 1.'),
  ...airStateParams,
});

export type CyclingInput = z.infer<typeof cyclingParams>;

/** A coded refusal of cycling_power (code, message, param paths, entity ids). */
export type CyclingRefusal = (code: string, message: string, paths?: string[], ids?: string[]) => CommandResult;
