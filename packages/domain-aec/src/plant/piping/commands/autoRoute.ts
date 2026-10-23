import { defineCommand, vec3, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { changed, report } from '@core/commands/noop';
import type { CadDocument } from '@core/model/types';
import type { PipeRun } from '@aec/plant/types';
import type { Vec3 } from '@core/model/vectors';
import { nextId } from '@lib/id';
import { buildRouteProblem, type BuiltProblem, type RouteRequest } from '../autoRoute/problem';
import { searchRoute } from '../autoRoute/search';
import { checkSolution, solutionFromSearch, type RouteSolution } from '../autoRoute/solution';
import { withRunEntities } from '../derive';
import { deriveRun } from '../routeParts';
import { getPiping, refuse, withPiping } from '../model';
import { routeParamsShape } from './routeParams';

/** Expansion cap of the in-process TypeScript search (02 RTE §8: measured, see TECHNICAL_SPEC as-built); above it: `llull auto_route`. */
export const TS_MAX_EXPANSIONS = 200_000;

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
    '(3D entities, legs of existing runs, keep-outs). The elbow centre-to-end and the flange sets of flanged ports come from the line spec (catalogue rows, ' +
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

const solutionSchema = z
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

/**
 * @affects creates 1 pipe run (plant.piping) + its derived, read-only part entities (`<runId>/<kind>-<k>`, layers P-PIPE / P-FITT / P-FLNG)
 * @invariant a supplied solution is committed only when checkSolution accepts it against the problem rebuilt from this document
 * @failure problem refusals (route_problem); RTE_AUTOROUTE_SOLUTION_INVALID; RTE_AUTOROUTE_NO_PATH; RTE_AUTOROUTE_BUDGET; a route whose parts do not derive
 */
export const autoRoutePipe = defineCommand({
  name: 'auto_route_pipe',
  description:
    'Route a pipe line automatically between two ports and add it as a pipe run: orthogonal legs on a lattice, fewest bends and shortest ' +
    'length for the bend cost, clear of every 3D entity, existing run and keep-out by pipe radius + insulation + clearance, rack elevations ' +
    `preferred. Without solution it runs the in-process A* (cap ${TS_MAX_EXPANSIONS} expansions; above it refuses RTE_AUTOROUTE_BUDGET: ` +
    'run llull auto_route, the native router). With solution (from llull auto_route) it checks the problem hash, every leg and the length / ' +
    'bends / cost before committing. The run is an ordinary run: it derives the same parts as route_pipe (cut pipe pieces, spec elbows, flange sets) and ' +
    'is refused if they do not derive. data = { runId, pis, centrelineToPiLengthMm, bends, cost, optimal, expansions, engine, problemHash, unverified, ' +
    'unverifiedReasons, parts, totalPipeMm }. Several lines: route them one after the other (each run becomes an obstacle for the next). Refusals: as ' +
    'route_problem plus RTE_AUTOROUTE_NO_PATH, RTE_AUTOROUTE_BUDGET, RTE_AUTOROUTE_SOLUTION_INVALID, and the derivation codes of route_pipe. Next: piping_takeoff.',
  params: z.object({
    ...routeParamsShape,
    maxExpansions: z.number().int().positive().optional().describe(`In-process search cap (default and maximum ${TS_MAX_EXPANSIONS}).`),
    solution: solutionSchema.optional(),
  }),
  run: (doc, params): CommandResult => {
    const result = built(doc, 'auto_route_pipe', params);
    if (!('ok' in result)) return result;
    const { problem, problemHash } = result;
    let solution: RouteSolution;
    if (params.solution !== undefined) {
      solution = { ...params.solution, pis: params.solution.pis.map((p) => p.map((v) => Math.round(v * 1000) / 1000) as unknown as Vec3) };
    } else {
      const cap = params.maxExpansions ?? TS_MAX_EXPANSIONS;
      if (cap > TS_MAX_EXPANSIONS)
        return refuse(
          doc,
          'auto_route_pipe',
          'RTE_AUTOROUTE_BUDGET',
          `maxExpansions ${cap} exceeds the in-process cap ${TS_MAX_EXPANSIONS}`,
          [],
          ['maxExpansions'],
        );
      const search = searchRoute(problem, cap);
      if (search.status === 'budget')
        return refuse(
          doc,
          'auto_route_pipe',
          'RTE_AUTOROUTE_BUDGET',
          `no route within ${search.expansions} expansions`,
          [params.lineId],
          ['maxExpansions'],
        );
      if (search.status !== 'found')
        return refuse(
          doc,
          'auto_route_pipe',
          'RTE_AUTOROUTE_NO_PATH',
          `no clear route in the grid box (${search.expansions} expansions)`,
          [params.lineId],
          ['gridMargin'],
        );
      solution = solutionFromSearch(problem, problemHash, search, 'ts');
    }
    // Every route, the in-process search's included, passes the same check before it is committed (PIs snapped to whole µm).
    const check = checkSolution(problem, problemHash, solution);
    if (!check.ok) return refuse(doc, 'auto_route_pipe', 'RTE_AUTOROUTE_SOLUTION_INVALID', check.reason, [params.lineId], [check.path]);
    const piping = getPiping(doc);
    const id = nextId('run');
    const run: PipeRun = {
      id,
      lineId: params.lineId,
      start: {
        point: result.from.point,
        direction: result.from.direction,
        ...(result.from.ref === undefined ? {} : { ref: result.from.ref }),
      },
      end: { point: result.to.point, direction: result.to.direction, ...(result.to.ref === undefined ? {} : { ref: result.to.ref }) },
      pis: solution.pis,
      autoRoute: {
        problemHash,
        cost: solution.cost,
        bends: solution.bends,
        expansions: solution.expansions,
        optimal: solution.optimal,
        engine: solution.engine,
      },
    };
    const stored = withPiping(doc, { ...piping, runs: { ...piping.runs, [id]: run }, runOrder: [...piping.runOrder, id] });
    const derived = deriveRun(stored, run);
    if (!derived.ok)
      return refuse(doc, 'auto_route_pipe', derived.code, derived.message, [...derived.ids], [...derived.paths], derived.detail);
    const next = withRunEntities(stored, id);
    return {
      ...changed(
        next,
        `auto_route_pipe: run ${id} on line ${result.line.lineNumber}: ${solution.bends} bend(s), ${solution.lengthMm} mm centreline-to-PI, ` +
          `cost ${solution.cost} µm (${solution.engine}, ${solution.expansions} expansions${solution.optimal ? ', optimal' : ''}); ` +
          `${derived.parts.length} part(s), ${derived.totalPipeMm.toFixed(3)} mm of pipe${derived.unverified ? `; unverified (${derived.unverifiedReasons.join('; ')})` : ''}.`,
        [id],
      ),
      data: {
        runId: id,
        pis: solution.pis,
        centrelineToPiLengthMm: solution.lengthMm,
        bends: solution.bends,
        cost: solution.cost,
        optimal: solution.optimal,
        expansions: solution.expansions,
        engine: solution.engine,
        problemHash,
        unverified: derived.unverified,
        unverifiedReasons: derived.unverifiedReasons,
        parts: derived.parts.length,
        totalPipeMm: derived.totalPipeMm,
      },
    };
  },
});
