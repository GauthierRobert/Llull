/**
 * Routes one line automatically and adds it as an ordinary run (02 RTE V2): the build / search / check / commit sequence shared by
 * `auto_route_pipe` and `auto_route_lines`. Pure; the run id is chosen by the caller so a multi-line transaction mints its ids once.
 */

import type { CadDocument } from '@core/model/types';
import type { PipeLine, PipeRun } from '@aec/plant/types';
import type { Vec3 } from '@core/model/vectors';
import { withRunEntities } from '../derive';
import { getPiping, withPiping } from '../model';
import { deriveRun } from '../routeParts';
import { buildRouteProblem, type RouteRequest } from './problem';
import { searchRoute } from './search';
import { checkSolution, solutionFromSearch, type RouteSolution } from './solution';

/** Expansion cap of the in-process TypeScript search, per first-move candidate (02 RTE §8, §13.3): above it, `llull auto_route`. */
export const TS_MAX_EXPANSIONS = 200_000;

export interface RouteOneOptions {
  readonly runId: string;
  /** In-process search cap per candidate (default and maximum `TS_MAX_EXPANSIONS`); ignored with a `solution`. */
  readonly maxExpansions?: number | undefined;
  /** A solution computed elsewhere (llull-route): validated, not searched. */
  readonly solution?: RouteSolution | undefined;
}

export interface RouteOneRefusal {
  readonly ok: false;
  readonly code: string;
  readonly message: string;
  readonly ids: readonly string[];
  readonly paths: readonly string[];
  readonly detail?: Readonly<Record<string, unknown>> | undefined;
}

export interface RoutedOne {
  readonly ok: true;
  readonly document: CadDocument;
  readonly runId: string;
  readonly line: PipeLine;
  readonly solution: RouteSolution;
  readonly problemHash: string;
  readonly parts: number;
  readonly totalPipeMm: number;
  readonly unverified: boolean;
  readonly unverifiedReasons: readonly string[];
}

const refusal = (code: string, message: string, ids: readonly string[], paths: readonly string[]): RouteOneRefusal => ({
  ok: false,
  code,
  message,
  ids,
  paths,
});

/** The solution with its PIs snapped to whole µm (what a JSON round trip of a native answer gives). */
const snapped = (solution: RouteSolution): RouteSolution => ({
  ...solution,
  pis: solution.pis.map((p) => p.map((v) => Math.round(v * 1000) / 1000) as unknown as Vec3),
});

/**
 * @failure problem refusals (RTE_* of route_problem); RTE_AUTOROUTE_BUDGET above the cap or when a candidate runs out before any route is found;
 *   RTE_AUTOROUTE_NO_PATH; RTE_AUTOROUTE_SOLUTION_INVALID; a route whose parts do not derive -> RouteOneRefusal
 */
export function routeOne(doc: CadDocument, request: RouteRequest, options: RouteOneOptions): RoutedOne | RouteOneRefusal {
  const built = buildRouteProblem(doc, request);
  if (!built.ok) return refusal(built.code, built.message, built.ids, built.paths);
  const { problem, problemHash } = built;
  let solution: RouteSolution;
  if (options.solution !== undefined) {
    solution = snapped(options.solution);
  } else {
    const cap = options.maxExpansions ?? TS_MAX_EXPANSIONS;
    if (cap > TS_MAX_EXPANSIONS)
      return refusal('RTE_AUTOROUTE_BUDGET', `maxExpansions ${cap} exceeds the in-process cap ${TS_MAX_EXPANSIONS}`, [], ['maxExpansions']);
    const search = searchRoute(problem, cap);
    if (search.status === 'budget')
      return refusal('RTE_AUTOROUTE_BUDGET', `no route within ${cap} expansions per candidate`, [request.lineId], ['maxExpansions']);
    if (search.status !== 'found')
      return refusal(
        'RTE_AUTOROUTE_NO_PATH',
        `no clear route in the grid box (${search.expansions} expansions)`,
        [request.lineId],
        ['gridMargin'],
      );
    solution = solutionFromSearch(problem, problemHash, search, 'ts');
  }
  const check = checkSolution(problem, problemHash, solution);
  if (!check.ok) return refusal('RTE_AUTOROUTE_SOLUTION_INVALID', check.reason, [request.lineId], [check.path]);
  const piping = getPiping(doc);
  const id = options.runId;
  const run: PipeRun = {
    id,
    lineId: request.lineId,
    start: { point: built.from.point, direction: built.from.direction, ...(built.from.ref === undefined ? {} : { ref: built.from.ref }) },
    end: { point: built.to.point, direction: built.to.direction, ...(built.to.ref === undefined ? {} : { ref: built.to.ref }) },
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
  if (!derived.ok) return { ...refusal(derived.code, derived.message, [...derived.ids], [...derived.paths]), detail: derived.detail };
  return {
    ok: true,
    document: withRunEntities(stored, id),
    runId: id,
    line: built.line,
    solution,
    problemHash,
    parts: derived.parts.length,
    totalPipeMm: derived.totalPipeMm,
    unverified: derived.unverified,
    unverifiedReasons: derived.unverifiedReasons,
  };
}
