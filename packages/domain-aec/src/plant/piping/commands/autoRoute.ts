import { defineCommand, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { changed, report } from '@core/commands/noop';
import type { CadDocument } from '@core/model/types';
import { nextId } from '@lib/id';
import { buildRouteProblem, type BuiltProblem, type RouteRequest } from '../autoRoute/problem';
import { routeOne, TS_MAX_EXPANSIONS } from '../autoRoute/routeOne';
import { refuse } from '../model';
import { routeParamsShape, routeSolutionSchema } from './routeParams';

const built = (doc: CadDocument, command: string, request: RouteRequest): BuiltProblem | CommandResult => {
  const result = buildRouteProblem(doc, request);
  return result.ok ? result : refuse(doc, command, result.code, result.message, result.ids, result.paths);
};

/**
 * @affects none (query)
 * @failure unknown line / port / keep-out, port in use, size mismatch, non-axis port, missing elbow or flange-set length, ports off one
 *   lattice, blocked stub -> RTE_* refusal
 */
export const routeProblem = defineCommand({
  name: 'route_problem',
  description:
    'Build the canonical auto-routing problem of a pipe line between two ports without routing it: lattice (cell, origin, box), port stubs, ' +
    'integer-micrometre costs (bend cost, rack-elevation penalty) and every obstacle box inflated by pipe radius + insulation + clearance ' +
    '(3D entities, the clash bodies of existing runs, keep-outs). The elbow centre-to-end and the flange sets of flanged ports come from the line spec (catalogue rows, ' +
    'not formulas). Ports are tie-in ids, equipment nozzles "<tag>:<mark>" or run ends. data = { problem, problemHash, defaults, elbowCentreToEnd, ' +
    'flangeSetLengths, portOwners, unverified, unverifiedReasons }; the native router (llull auto_route, llull-compute route) solves it and auto_route_pipe ' +
    'checks the solution against the same hash. Refusals: RTE_UNITS_UNSUPPORTED (non-mm document), RTE_UNKNOWN_LINE, RTE_UNKNOWN_PORT, RTE_PORT_IN_USE, ' +
    'RTE_SIZE_MISMATCH, RTE_PORT_DIRECTION, RTE_RATING_MISMATCH, RTE_FACING_MISMATCH, RTE_SPEC_UNKNOWN, RTE_SPEC_NO_COMPONENT, RTE_UNKNOWN_KEEPOUT, ' +
    'RTE_AUTOROUTE_NO_PATH. Next: auto_route_pipe (or llull auto_route for large boxes).',
  annotations: { readOnly: true },
  params: z.object(routeParamsShape),
  run: (doc, params): CommandResult => {
    const result = built(doc, 'route_problem', params);
    if (!('ok' in result)) return result;
    const { problem, problemHash, info } = result;
    const size = problem.bounds.max.map((v, dim) => v - (problem.bounds.min[dim] as number) + 1);
    return report(
      doc,
      `route_problem: line ${params.lineId}, ${size.join(' x ')} cells of ${problem.cellUm / 1000} mm, ${problem.obstacles.length} obstacle box(es), ` +
        `minimum leg ${problem.minLegCells} cell(s); problemHash ${problemHash.slice(0, 12)}…`,
      { problem, problemHash, ...info, tsMaxExpansions: TS_MAX_EXPANSIONS },
    );
  },
});

/**
 * @affects creates 1 pipe run (plant.piping) + its derived, read-only part entities (`<runId>/<kind>-<k>`, layers P-PIPE / P-FITT / P-FLNG)
 * @invariant a supplied solution is committed only when checkSolution accepts it against the problem rebuilt from this document
 * @failure problem refusals (route_problem); RTE_AUTOROUTE_SOLUTION_INVALID; RTE_AUTOROUTE_NO_PATH; RTE_AUTOROUTE_BUDGET; a route whose parts do not derive
 */
export const autoRoutePipe = defineCommand({
  name: 'auto_route_pipe',
  description:
    'Route a pipe line automatically between two ports and add it as a pipe run: orthogonal legs on a lattice, fewest bends and shortest ' +
    'length for the bend cost, clear of every 3D entity, existing run (its pipe, insulation, flanges, valve operators, branches) and keep-out by pipe radius + insulation + clearance, rack elevations ' +
    `preferred. Without solution it runs the in-process search (A* per first-move candidate, cap ${TS_MAX_EXPANSIONS} expansions per candidate; above it refuses RTE_AUTOROUTE_BUDGET: ` +
    'run llull auto_route, the native router). With solution (from llull auto_route) it checks the problem hash, every leg and the length / ' +
    'bends / cost before committing. The run is an ordinary run: it derives the same parts as route_pipe (cut pipe pieces, spec elbows, flange sets) and ' +
    'is refused if they do not derive. data = { runId, pis, centrelineToPiLengthMm, bends, cost, optimal, expansions, engine, problemHash, unverified, ' +
    'unverifiedReasons, parts, totalPipeMm }. Several lines: auto_route_lines (automatic order, one transaction). Refusals: as ' +
    'route_problem plus RTE_AUTOROUTE_NO_PATH, RTE_AUTOROUTE_BUDGET, RTE_AUTOROUTE_SOLUTION_INVALID, and the derivation codes of route_pipe. Next: piping_takeoff.',
  params: z.object({
    ...routeParamsShape,
    maxExpansions: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(`In-process search cap per first-move candidate (default and maximum ${TS_MAX_EXPANSIONS}).`),
    solution: routeSolutionSchema.optional(),
  }),
  run: (doc, params): CommandResult => {
    const routed = routeOne(doc, params, { runId: nextId('run'), maxExpansions: params.maxExpansions, solution: params.solution });
    if (!routed.ok) return refuse(doc, 'auto_route_pipe', routed.code, routed.message, [...routed.ids], [...routed.paths], routed.detail);
    const { solution } = routed;
    return {
      ...changed(
        routed.document,
        `auto_route_pipe: run ${routed.runId} on line ${routed.line.lineNumber}: ${solution.bends} bend(s), ${solution.lengthMm} mm centreline-to-PI, ` +
          `cost ${solution.cost} µm (${solution.engine}, ${solution.expansions} expansions${solution.optimal ? ', optimal' : ''}); ` +
          `${routed.parts} part(s), ${routed.totalPipeMm.toFixed(3)} mm of pipe${routed.unverified ? `; unverified (${routed.unverifiedReasons.join('; ')})` : ''}.`,
        [routed.runId],
      ),
      data: {
        runId: routed.runId,
        pis: solution.pis,
        centrelineToPiLengthMm: solution.lengthMm,
        bends: solution.bends,
        cost: solution.cost,
        optimal: solution.optimal,
        expansions: solution.expansions,
        engine: solution.engine,
        problemHash: routed.problemHash,
        unverified: routed.unverified,
        unverifiedReasons: routed.unverifiedReasons,
        parts: routed.parts,
        totalPipeMm: routed.totalPipeMm,
      },
    };
  },
});
