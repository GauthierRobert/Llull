/** Params shared by `route_problem` and `auto_route_pipe` (they must build the same problem). */

import { vec3, z } from '@core/commands/schema';
import { ROUTE_DEFAULTS } from '../autoRoute/problem';

const endpoint = (
  which: string,
): z.ZodType<{ portId: string } | { point: [number, number, number]; direction: [number, number, number] }> =>
  z
    .union([
      z.object({ portId: z.string().describe('Tie-in point id (add_tie_in_point).') }),
      z.object({
        point: vec3('Open-end point [x, y, z].'),
        direction: vec3('Face direction at the open end, pointing toward the pipe (an axis direction).'),
      }),
    ])
    .describe(`${which} end: { portId } or an open end { point, direction }.`);

export const routeParamsShape = {
  lineId: z.string().describe('Pipe line id (create_pipeline).'),
  from: endpoint('Start'),
  to: endpoint('End'),
  grid: z
    .number()
    .positive()
    .optional()
    .describe(`Lattice cell, mm (default ${ROUTE_DEFAULTS.grid}). Both port stubs must land on one lattice.`),
  bendCost: z
    .number()
    .min(0)
    .optional()
    .describe(`Cost of one bend in mm of pipe (default ${ROUTE_DEFAULTS.bendCost}): higher = fewer bends, longer pipe.`),
  clearance: z
    .number()
    .min(0)
    .optional()
    .describe(`Gap kept to every obstacle beyond the pipe (or insulation) surface, mm (default ${ROUTE_DEFAULTS.clearance}).`),
  gridMargin: z
    .number()
    .min(0)
    .optional()
    .describe(`How far the search box extends beyond the two port stubs, mm (default ${ROUTE_DEFAULTS.gridMargin}).`),
  preferElevations: z
    .array(z.number())
    .optional()
    .describe('Preferred centreline elevations z (e.g. rack levels), mm: horizontal pipe elsewhere pays elevationPenalty.'),
  elevationPenalty: z
    .number()
    .min(0)
    .optional()
    .describe(`Extra cost per mm of horizontal pipe off every preferred elevation (default ${ROUTE_DEFAULTS.elevationPenalty}).`),
  keepOut: z
    .array(z.string())
    .optional()
    .describe('Entity ids the route must avoid even when a port sits on them (maintenance space, access).'),
  keepOutBoxes: z
    .array(z.object({ min: vec3('Box minimum corner [x, y, z].'), max: vec3('Box maximum corner [x, y, z].') }))
    .optional()
    .describe('Extra keep-out boxes (world, mm) the route must avoid.'),
  elbowCentreToEnd: z
    .number()
    .positive()
    .optional()
    .describe('LR 90 elbow centre-to-end, mm (default: ASME B16.9 row for DN 50, 80, 100, 150, 200).'),
  flangeSetLength: z
    .number()
    .min(0)
    .optional()
    .describe('Gasket + mating flange through hub, mm: required when a port is flanged (FL) until the spec catalogue lands.'),
};
