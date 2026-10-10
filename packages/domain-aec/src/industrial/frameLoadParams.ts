/**
 * Load parameters shared by the portal-frame, foundation and footing commands: schema, validation, description.
 * @layer domain-aec
 * @pure
 */

import type { CadDocument } from '@core/model/types';
import { z } from '@core/commands/schema';
import { existingLevelId, getBuilding } from '../model';
import { isPositiveNumber, isNonNegativeNumber } from '@lib/isFiniteNumber';
import type { CraneModel, FrameLoads } from './frameModelTypes';
import { existingLevelIdParam } from '../levelParams';

/** Load parameters shared by check_portal_frames and design_portal_frames. */
export const FRAME_LOAD_SHAPE = {
  deadLoad: z
    .number()
    .optional()
    .describe('Roof dead load (build-up, purlins, services), kN/m². Default 0.5.'),
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
  hoistingClass: z
    .enum(['HC1', 'HC2', 'HC3', 'HC4'])
    .optional()
    .describe(
      'EN 1991-3 hoisting class for the dynamic factor φ2 = φ2,min + β2 vh (HC1 1.05 + 0.17 vh, ' +
        'HC2 1.10 + 0.34 vh, HC3 1.15 + 0.51 vh, HC4 1.20 + 0.68 vh). Default HC2.',
    ),
  hoistingSpeed: z
    .number()
    .optional()
    .describe('Hoisting speed vh in m/s (>= 0) for φ2. Default 0.1.'),
  craneSelfWeight: z
    .number()
    .optional()
    .describe(
      'Crane self-weight Gc in kN (> 0, bridge + trolley; trolley = 0.2 Gc). Default 0.5 Q + 20 kN.',
    ),
  minHookApproach: z
    .number()
    .optional()
    .describe(
      'Minimum approach of the hook to a rail in m (>= 0): the trolley position that maximises the wheel load. Default 1.0.',
    ),
  wheelBase: z
    .number()
    .optional()
    .describe(
      'Wheel base a of a crane rail wheel group in mm (> 0), used for the transverse drive force HT = φ5 ξ M / a. Default 3000.',
    ),
  levelId: existingLevelIdParam,
};

type FrameLoadParams = z.output<z.ZodObject<typeof FRAME_LOAD_SHAPE>>;

/** Validated loads + level, or the failure reason. */
export function resolveFrameLoads(
  doc: CadDocument,
  params: FrameLoadParams,
): { loads: FrameLoads; levelId: string } | { reason: string } {
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
  if (
    (hoistingSpeed !== undefined && !isNonNegativeNumber(hoistingSpeed)) ||
    (minHookApproach !== undefined && !isNonNegativeNumber(minHookApproach))
  ) {
    return { reason: 'hoistingSpeed and minHookApproach must be >= 0' };
  }
  if (
    (craneSelfWeight !== undefined && !isPositiveNumber(craneSelfWeight)) ||
    (wheelBase !== undefined && !isPositiveNumber(wheelBase))
  ) {
    return { reason: 'craneSelfWeight and wheelBase must be > 0' };
  }
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
