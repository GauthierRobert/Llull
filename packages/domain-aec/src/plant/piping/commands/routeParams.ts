/** Params shared by `route_problem` and `auto_route_pipe` (they must build the same problem). */

import { vec3, z } from '@core/commands/schema';
import { ROUTE_DEFAULTS } from '../autoRoute/problem';

const endpoint = (
  which: string,
): z.ZodType<{ portId: string } | { point: [number, number, number]; direction: [number, number, number] }> =>
  z
    .union([
      z.object({
        portId: z
          .string()
          .describe(
            'Port id: tie-in point id (add_tie_in_point), "<tag>:<mark>" of an equipment nozzle (add_nozzle) or "<runId>:start|end".',
          ),
      }),
      z.object({
        point: vec3('Open-end point [x, y, z].'),
        direction: vec3('Face direction at the open end, pointing toward the pipe (an axis direction).'),
      }),
    ])
    .describe(`${which} end: { portId } or an open end { point, direction }.`);

/** The search settings of a route request (everything but the line and its ends). */
export const routeSettingsShape = {
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
};

export const routeParamsShape = {
  lineId: z.string().describe('Pipe line id (create_pipeline).'),
  from: endpoint('Start'),
  to: endpoint('End'),
  ...routeSettingsShape,
};

/** A route computed elsewhere (llull auto_route, llull-route); validated against the problem rebuilt from the document before it is committed. */
export const routeSolutionSchema = z
  .object({
    problemHash: z.string().describe('route_problem data.problemHash the solution was computed for.'),
    pis: z.array(vec3('Point of intersection [x, y, z], mm.')).describe('Interior points of intersection in route order.'),
    lengthMm: z.number().describe('Port-to-port centreline-to-PI length, mm.'),
    bends: z.number().int().min(0).describe('Number of bends (= pis.length).'),
    cost: z.number().int().min(0).describe('Integer µm cost: lattice length + bends x bendCost + elevation penalties.'),
    optimal: z.boolean().describe('Caller-asserted (recorded as given): true when the search proved the route minimal.'),
    expansions: z.number().int().min(0).describe('Caller-asserted (recorded as given): states the search expanded.'),
    engine: z
      .string()
      .describe(
        "Caller-asserted source (recorded as given): 'llull-route' (set by llull auto_route), 'ts' or a name for a hand-written route.",
      ),
  })
  .describe('A solution of route_problem (from llull auto_route); validated before it is committed.');
