/** road_load_power params (one schema for both models) and the refusal callback its model runners share. */

import { z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { airStateParams } from '../shared/airState';
import { speedParam } from '../shared/speed';
import { flowParams } from './geometryArea';

export const roadLoadParams = z.object({
  model: z
    .enum(['road_load', 'bassett_1999'])
    .optional()
    .describe(
      'road_load (default: any road vehicle, Martin et al. 1998 terms) or bassett_1999 (track cycling hour record, Bassett et al. 1999).',
    ),
  vehicle: z
    .enum(['generic', 'bicycle'])
    .optional()
    .describe(
      'road_load: generic (default: crr required, no wheel / bearing terms, drivetrain 1) or bicycle (Martin 1998 preset: crr 0.0032, Fw 0.0044 m², bearing loss, drivetrain 0.976).',
    ),
  ...speedParam,
  powerW: z
    .number()
    .optional()
    .describe('Power at the drivetrain input in W (crank, motor shaft; > 0); the command solves the steady speed. Give this or speed.'),
  massKg: z.number().optional().describe('road_load: total moving mass in kg (vehicle + rider / payload, > 0). Required.'),
  cdA: z.number().optional().describe('road_load: drag area CdA in m² (> 0). Or cd + entityIds.'),
  cd: z.number().optional().describe('road_load: drag coefficient on the frontal area of entityIds.'),
  entityIds: z
    .array(z.string())
    .optional()
    .describe('road_load: vehicle (+ rider) solids; frontal area along flowDirection (default [1, 0, 0]).'),
  ...flowParams,
  crr: z
    .number()
    .optional()
    .describe('road_load: rolling resistance coefficient, 0..0.1. Required for generic; bicycle default 0.0032 (Martin 1998 road tyres).'),
  gradePercent: z.number().optional().describe('road_load: road grade in % (rise / run × 100, -25..25). Default 0.'),
  headwindMS: z.number().optional().describe('road_load: wind along the road in m/s, + headwind / - tailwind. Default 0.'),
  wheelAreaM2: z
    .number()
    .optional()
    .describe('road_load: wheel rotation drag area Fw in m², added to CdA (bicycle default 0.0044, generic 0).'),
  drivetrainEfficiency: z
    .number()
    .optional()
    .describe('road_load: drivetrain efficiency in (0, 1] (bicycle default 0.976; generic default 1 = power at the wheels).'),
  bearingLosses: z
    .boolean()
    .optional()
    .describe('road_load: add the bicycle wheel-bearing loss V(91 + 8.7·V) mW (bicycle default true, generic false).'),
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

export type RoadLoadInput = z.infer<typeof roadLoadParams>;

/** A coded refusal of road_load_power (code, message, param paths, entity ids). */
export type RoadLoadRefusal = (code: string, message: string, paths?: string[], ids?: string[]) => CommandResult;
