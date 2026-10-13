/** Load parameters shared by the portal-frame, foundation and footing commands: schema, validation, description. */

import type { CadDocument } from '@core/model/types';
import { z } from '@core/commands/schema';
import { existingLevelId, getBuilding } from '../../building/model';
import { isNonNegativeNumber } from '@lib/isFiniteNumber';
import {
  craneSelfWeightField,
  craneValueProblem,
  hoistingClassField,
  hoistingSpeedField,
  minHookApproachField,
  wheelBaseField,
} from '../common/craneParams';
import type { CraneModel, FrameLoads } from './frameModelTypes';
import { existingLevelIdParam } from '../../building/levelParams';

/** Load parameters shared by check_portal_frames and design_portal_frames. */
export const FRAME_LOAD_SHAPE = {
  deadLoad: z.number().optional().describe('Roof dead load (build-up, purlins, services), kN/m². Default 0.5.'),
  snowLoad: z.number().optional().describe('Roof snow load, kN/m². Default 0.8.'),
  windPressure: z
    .number()
    .optional()
    .describe(
      'Peak velocity pressure qp, kN/m² (EN 1991-1-4; e.g. 0.6–1.0). Default 0 = wind not applied. ' +
        'Coefficients: walls cpe +0.8 / −0.5, roof −0.6 (monopitch roofs, EN 1991-1-4 Tab. 7.3a zone H: −0.6 with ' +
        'wind on the low eaves, −0.8 on the high eaves), each with internal pressure cpi +0.2 and −0.3.',
    ),
  craneCapacity: z
    .number()
    .optional()
    .describe(
      'Crane capacity in tonnes for every runway on the level. Default: read from the runways ' +
        '(add_crane_runway capacity); 0 = ignore cranes.',
    ),
  hoistingClass: hoistingClassField,
  hoistingSpeed: hoistingSpeedField,
  craneSelfWeight: craneSelfWeightField,
  minHookApproach: minHookApproachField,
  wheelBase: wheelBaseField,
  levelId: existingLevelIdParam,
};

type FrameLoadParams = z.output<z.ZodObject<typeof FRAME_LOAD_SHAPE>>;

/** Validated loads + level, or the failure reason. */
export function resolveFrameLoads(doc: CadDocument, params: FrameLoadParams): { loads: FrameLoads; levelId: string } | { reason: string } {
  const { deadLoad = 0.5, snowLoad = 0.8, windPressure = 0, craneCapacity } = params;
  if (
    !isNonNegativeNumber(deadLoad) ||
    !isNonNegativeNumber(snowLoad) ||
    !isNonNegativeNumber(windPressure) ||
    (craneCapacity !== undefined && !isNonNegativeNumber(craneCapacity))
  ) {
    return { reason: 'deadLoad, snowLoad, windPressure and craneCapacity must be >= 0' };
  }
  const { hoistingClass, hoistingSpeed, craneSelfWeight, minHookApproach, wheelBase } = params;
  const craneProblem = craneValueProblem({ hoistingSpeed, minHookApproach, craneSelfWeight, wheelBase });
  if (craneProblem !== undefined) return { reason: craneProblem };
  const building = getBuilding(doc);
  const levelId = existingLevelId(building, params.levelId);
  if (levelId === undefined) return { reason: `no level '${params.levelId ?? ''}'` };
  const craneModel: CraneModel = {
    ...(hoistingClass !== undefined ? { hoistingClass } : {}),
    ...(hoistingSpeed !== undefined ? { hoistingSpeed } : {}),
    ...(craneSelfWeight !== undefined ? { craneSelfWeight } : {}),
    ...(minHookApproach !== undefined ? { minHookApproach } : {}),
    ...(wheelBase !== undefined ? { wheelBase } : {}),
  };
  return {
    loads: {
      deadLoad,
      snowLoad,
      windPressure,
      ...(craneCapacity !== undefined ? { craneCapacity } : {}),
      ...(Object.keys(craneModel).length > 0 ? { craneModel } : {}),
    },
    levelId,
  };
}

/** "G = 0.5 kN/m² + self-weight, S = 0.8, W = 0.7 (qp), cranes from runways". */
export function describeLoads(loads: FrameLoads): string {
  return (
    `G = ${loads.deadLoad} kN/m² + self-weight, S = ${loads.snowLoad} kN/m², ` +
    `${loads.windPressure > 0 ? `qp = ${loads.windPressure} kN/m²` : 'no wind (windPressure = 0)'}, ` +
    `${loads.craneCapacity === undefined ? 'cranes from runways' : loads.craneCapacity === 0 ? 'cranes ignored' : `cranes ${loads.craneCapacity} t`}`
  );
}
