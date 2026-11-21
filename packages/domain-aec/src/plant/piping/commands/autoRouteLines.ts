import { defineCommand, vec3, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { changed, report } from '@core/commands/noop';
import { nextId } from '@lib/id';
import type { RouteRequest } from '../autoRoute/problem';
import { TS_MAX_EXPANSIONS } from '../autoRoute/routeOne';
import {
  lineMetrics,
  ORDER_RULE,
  routeTransaction,
  routingOrder,
  type Attempt,
  type LineEntry,
  type LineOutcome,
} from '../autoRoute/lines';
import { applyBranches, type BranchRequest } from '../autoRoute/branches';
import { refuse } from '../model';
import { legsInput, portOrPoint, viaInput } from './routeInput';
import { routeParamsShape, routeSettingsShape, routeSolutionSchema } from './routeParams';

/** Most lines one transaction takes (each is searched and derived in turn). */
const MAX_LINES = 64;
const DEFAULT_ATTEMPTS = 4;
const MAX_ATTEMPTS = 12;

/** Route settings shared by the lines of a request; a line's own value wins. */
const common = z
  .object(routeSettingsShape)
  .describe('Settings applied to every line that does not set its own (grid, bendCost, clearance, gridMargin, preferElevations, ...).');

const lineSchema = z.object({
  ...routeParamsShape,
  maxExpansions: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(`In-process search cap per first-move candidate for this line (default the request value, maximum ${TS_MAX_EXPANSIONS}).`),
  solution: routeSolutionSchema.optional(),
});

type LineParams = z.infer<typeof lineSchema>;

const linesField = z
  .array(lineSchema)
  .min(1)
  .max(MAX_LINES)
  .describe(`The lines to route (1 to ${MAX_LINES}), each as for auto_route_pipe: { lineId, from, to, ...settings }.`);

/** The request of a line: the shared settings under the line's own, unset values dropped. */
function requestOf(line: LineParams, shared: z.infer<typeof common> | undefined): RouteRequest {
  const own = Object.fromEntries(
    Object.entries(line).filter(([key, value]) => value !== undefined && key !== 'solution' && key !== 'maxExpansions'),
  );
  return { ...shared, ...own } as RouteRequest;
}

const branchSchema = z.object({
  lineId: z.string().min(1).describe('The branch line (an existing pipe line, NOT one of lines): its run is taken off the header.'),
  headerLineId: z
    .string()
    .min(1)
    .describe('The header: the lineId of one of lines. It is routed first; the branch is taken off its run afterwards.'),
  at: z
    .union([
      z.object({ point: vec3('A point [x, y, z] on the routed header centreline, within 0.01 mm.') }),
      z.object({
        leg: z.number().int().min(0).describe('Header leg index of the routed run.'),
        distance: z.number().positive().describe('Distance from the leg start, mm.'),
      }),
      z.object({ nearTo: vec3('A point [x, y, z]: the branch leaves the header at the centreline point nearest to it (inside a leg).') }),
    ])
    .describe(
      'Where the branch leaves the header, as add_branch at, or { nearTo } to take the nearest centreline point (the header is not routed yet when the request is written).',
    ),
  dn: z.number().int().positive().optional().describe('Branch size DN (default the size of the branch line).'),
  angleToleranceDeg: z
    .number()
    .positive()
    .max(22.5)
    .optional()
    .describe(
      'Overrides the spec angle tolerance for the perpendicular check and the branch elbows, degrees, 22.5 at most (as add_branch). Stored on the branch run.',
    ),
  to: portOrPoint.optional().describe('Branch end: a free port of the branch size or an open point, as add_branch to.'),
  legs: legsInput,
  via: viaInput,
});

const branchesField = z
  .array(branchSchema)
  .min(1)
  .max(MAX_LINES)
  .describe(
    'Branches routed together with their headers: after the header lines are routed (and before the commit) each branch is taken off its header run with add_branch (the spec branch-table tee / olet / stub-in), in this order. ' +
      'All or nothing like the lines: a branch that cannot reach its header refuses RTE_AUTOROUTE_BRANCH_UNREACHABLE (with partial the routed lines and the branches that placed are kept and the others reported, as for lines). Branch run and branch point ids are minted in request order of branches (a failed branch under partial can shift the ids of the later ones; keep the order to keep the ids).',
  );

const orderedOutcome = (outcome: LineOutcome): Record<string, unknown> => ({
  lineId: outcome.lineId,
  status: outcome.status,
  ...(outcome.runId === undefined ? {} : { runId: outcome.runId }),
  ...(outcome.code === undefined ? {} : { code: outcome.code, message: outcome.message }),
  ...(outcome.solution === undefined
    ? {}
    : {
        bends: outcome.solution.bends,
        centrelineToPiLengthMm: outcome.solution.lengthMm,
        cost: outcome.solution.cost,
        optimal: outcome.solution.optimal,
        expansions: outcome.solution.expansions,
        engine: outcome.solution.engine,
        problemHash: outcome.problemHash,
      }),
});

const attemptData = (attempt: Attempt): Record<string, unknown> => ({
  order: attempt.order,
  routed: attempt.routed,
  lines: attempt.outcomes.map(orderedOutcome),
});

const duplicate = (lines: readonly LineParams[]): number =>
  lines.findIndex((line, index) => lines.findIndex((other) => other.lineId === line.lineId) !== index);

/**
 * @affects none (query)
 * @failure none: an unknown line or port counts as DN 0 / distance 0 and is refused by the routing command
 */
export const routeLinesOrder = defineCommand({
  name: 'route_lines_order',
  description:
    'Say in which order auto_route_lines would route several lines, without routing: lines promoted by earlier failures first, then DN descending ' +
    '(wide lines claim space first), then straight-line (Manhattan) distance between the two ends descending, then the request position. ' +
    'promote lists line ids moved to the front (the latest first), as the retry of auto_route_lines does. data = { order: [lineId], rule, lines: [{ lineId, dn, distanceMm }] }. ' +
    'Read-only; the native transport (llull auto_route with lines) uses it to plan.',
  annotations: { readOnly: true },
  params: z.object({
    lines: linesField,
    common: common.optional(),
    promote: z.array(z.string()).optional().describe('Line ids moved to the front, the latest promoted first.'),
  }),
  run: (doc, params): CommandResult => {
    const requests = params.lines.map((line) => requestOf(line, params.common));
    const order = routingOrder(doc, requests, params.promote ?? []);
    return report(doc, `route_lines_order: ${order.map((index) => (requests[index] as RouteRequest).lineId).join(', ')}`, {
      order: order.map((index) => (requests[index] as RouteRequest).lineId),
      rule: ORDER_RULE,
      lines: requests.map((request) => ({ lineId: request.lineId, ...lineMetrics(doc, request) })),
    });
  },
});

/**
 * @affects creates one pipe run per routed line (plant.piping) + their derived, read-only part entities; ids minted once per request (`run-<step>.<k>`, k = request position); with branches also one branch run + branch point per placed branch (ids minted after the lines, in branch request order) and the header run's `branches` (re-derived: tee / olet part, shortened pieces)
 * @invariant all-or-nothing unless partial; each routed run is an obstacle for the next line; the same document and params give the same order, attempts and ids; branch ids follow the branch order (a failed branch under partial can shift the later ones)
 * @failure duplicate lineId or solutions without order: given, a branch whose header is not in lines / is left out of sequence (RTE_AUTOROUTE_LINES_INVALID); a branch that cannot be placed or whose header is not routed (RTE_AUTOROUTE_BRANCH_UNREACHABLE, nothing changes unless partial); a line that cannot be routed in any tried order (RTE_AUTOROUTE_LINES_FAILED, no line routed with partial)
 */
export const autoRouteLines = defineCommand({
  name: 'auto_route_lines',
  description:
    'Route several pipe lines automatically in one transaction, in an automatic order, each routed run an obstacle for the next. order auto (default): ' +
    'DN descending, then straight-line distance descending, then request position; when a line cannot be routed because earlier lines are in the way, the first line ' +
    'that fails is promoted to the front and the pass is repeated, up to maxAttempts passes (default 4, at most 12). order given: exactly the request order (or only the lines of sequence, in that order; run ids still follow the request position), one pass (the ' +
    'native transport uses it with solutions, one per line, each validated against the problem of its turn). With sequence the lines left out are skipped by request and do not count: all-or-nothing is about the sequenced lines. Default all-or-nothing: if any line cannot be routed in ' +
    'any tried order nothing changes and RTE_AUTOROUTE_LINES_FAILED names every line and why; partial: true keeps the lines that routed (the pass that routed most) and ' +
    'reports the others. Each line is routed as auto_route_pipe does (spec fittings, clash-body obstacles, rack elevations) and becomes an ordinary run. ' +
    'data = { order (routing order of the committed pass), attempts: [{ order, routed, lines }], lines: [{ lineId, status routed|failed|skipped, runId, bends, ' +
    'centrelineToPiLengthMm, cost, engine, code, message }], routed, failed, complete }. Run ids are minted once per request position, so any order and any retry gives the same ids. ' +
    'branches [{ lineId, headerLineId, at, dn, angleToleranceDeg, to / legs / via }] route a branch together with its header: the header (a line of lines) is routed first, then each branch is taken off the routed header run with add_branch (the header spec branch-table tee, olet or stub-in; at { point } | { leg, distance } | { nearTo } = nearest centreline point), all in this one call; data.branches = [{ lineId, headerLineId, status, runId, branchId, headerRunId, fitting, code, message }]; a branch that cannot reach its header is RTE_AUTOROUTE_BRANCH_UNREACHABLE (nothing changes, unless partial: then the routed lines and the placed branches are kept and the rest reported). A branch whose header line is left out of sequence is RTE_AUTOROUTE_LINES_INVALID. llull auto_route with lines and branches plans the lines with the native router and places the branches in its single commit. ' +
    'In-process search is capped per first-move candidate (maxExpansions); for large grids use llull auto_route with lines (native router). Refusals: RTE_AUTOROUTE_LINES_INVALID, RTE_AUTOROUTE_LINES_FAILED, RTE_AUTOROUTE_BRANCH_UNREACHABLE.',
  params: z.object({
    lines: linesField,
    common: common.optional(),
    order: z
      .enum(['auto', 'given'])
      .optional()
      .describe('auto (default): the documented order with retries; given: the request order, one pass.'),
    partial: z.boolean().optional().describe('true: keep the lines that routed and report the rest; false (default): all or nothing.'),
    sequence: z
      .array(z.string())
      .optional()
      .describe(
        'With order given: the line ids to route, in this order (default every line in request order). Lines left out are skipped (reported, not routed); run ids still follow the request position.',
      ),
    maxAttempts: z
      .number()
      .int()
      .min(1)
      .max(MAX_ATTEMPTS)
      .optional()
      .describe(`Passes tried with order auto (default ${DEFAULT_ATTEMPTS}, at most ${MAX_ATTEMPTS}).`),
    branches: branchesField.optional(),
    maxExpansions: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(`Default in-process search cap per first-move candidate (maximum ${TS_MAX_EXPANSIONS}).`),
  }),
  run: (doc, params): CommandResult => {
    const mode = params.order ?? 'auto';
    const twice = duplicate(params.lines);
    if (twice >= 0)
      return refuse(
        doc,
        'auto_route_lines',
        'RTE_AUTOROUTE_LINES_INVALID',
        `line ${params.lines[twice]?.lineId} is listed twice`,
        [params.lines[twice]?.lineId ?? ''],
        [`lines.${twice}.lineId`],
      );
    const branches = (params.branches ?? []) as BranchRequest[];
    const badBranch = branches.findIndex(
      (branch, at) =>
        !params.lines.some((line) => line.lineId === branch.headerLineId) ||
        params.lines.some((line) => line.lineId === branch.lineId) ||
        branches.findIndex((other) => other.lineId === branch.lineId) !== at,
    );
    if (badBranch >= 0)
      return refuse(
        doc,
        'auto_route_lines',
        'RTE_AUTOROUTE_LINES_INVALID',
        `branch ${branches[badBranch]?.lineId}: its headerLineId must be a line of lines, and the branch line must not be one of lines nor listed twice`,
        [branches[badBranch]?.lineId ?? ''],
        [`branches.${badBranch}`],
      );
    const unsequenced = branches.findIndex((branch) => params.sequence !== undefined && !params.sequence.includes(branch.headerLineId));
    if (unsequenced >= 0)
      return refuse(
        doc,
        'auto_route_lines',
        'RTE_AUTOROUTE_LINES_INVALID',
        `branch ${branches[unsequenced]?.lineId}: its header ${branches[unsequenced]?.headerLineId} is left out of sequence, so it would not be routed`,
        [branches[unsequenced]?.lineId ?? ''],
        [`branches.${unsequenced}.headerLineId`],
      );
    const solved = params.lines.findIndex((line) => line.solution !== undefined);
    if (solved >= 0 && mode !== 'given')
      return refuse(
        doc,
        'auto_route_lines',
        'RTE_AUTOROUTE_LINES_INVALID',
        'a solution is valid for one routing order: set order to "given"',
        [],
        [`lines.${solved}.solution`],
      );
    const sequence = params.sequence;
    if (sequence !== undefined) {
      const bad = sequence.find((id, at) => !params.lines.some((line) => line.lineId === id) || sequence.indexOf(id) !== at);
      if (mode !== 'given' || bad !== undefined)
        return refuse(
          doc,
          'auto_route_lines',
          'RTE_AUTOROUTE_LINES_INVALID',
          mode !== 'given' ? 'sequence needs order "given"' : `sequence names "${bad}" twice or not in lines`,
          [],
          ['sequence'],
        );
    }
    const entries: LineEntry[] = params.lines.map((line) => ({
      request: requestOf(line, params.common),
      runId: nextId('run'),
      maxExpansions: line.maxExpansions ?? params.maxExpansions,
      solution: line.solution,
    }));
    const transaction = routeTransaction(doc, entries, {
      order: mode,
      partial: params.partial === true,
      maxAttempts: params.maxAttempts ?? DEFAULT_ATTEMPTS,
      sequence,
    });
    const { best } = transaction;
    // Lines left out of the sequence are skipped by request: neither routed nor failed.
    const asked = sequence ?? params.lines.map((line) => line.lineId);
    const failed = best.outcomes.filter((outcome) => outcome.status !== 'routed' && asked.includes(outcome.lineId));
    const data = {
      order: best.order,
      attempts: transaction.attempts.map(attemptData),
      lines: best.outcomes.map(orderedOutcome),
      routed: best.routed,
      failed: failed.length,
      complete: transaction.complete,
      rule: mode === 'auto' ? ORDER_RULE : 'request order',
    };
    const detail = (outcome: LineOutcome): string =>
      `${outcome.lineId}${outcome.code === undefined ? ' (not tried)' : ` ${outcome.code}: ${outcome.message}`}`;
    if (!transaction.complete && (params.partial !== true || best.routed === 0)) {
      const first = best.outcomes.findIndex((outcome) => outcome.status === 'failed');
      const path = `lines.${params.lines.findIndex((line) => line.lineId === best.outcomes[first]?.lineId)}`;
      return refuse(
        doc,
        'auto_route_lines',
        'RTE_AUTOROUTE_LINES_FAILED',
        `${failed.length} of ${asked.length} line(s) not routed after ${transaction.attempts.length} pass(es): ${failed.map(detail).join('; ')}`,
        failed.map((outcome) => outcome.lineId),
        [path],
        data,
      );
    }
    const placed = applyBranches(best.document, branches, best.outcomes);
    const unreached = placed.outcomes.filter((outcome) => outcome.status !== 'routed');
    const branchData = { ...data, branches: placed.outcomes.map((outcome) => ({ ...outcome })) };
    if (unreached.length > 0 && params.partial !== true)
      return refuse(
        doc,
        'auto_route_lines',
        'RTE_AUTOROUTE_BRANCH_UNREACHABLE',
        `${unreached.length} of ${branches.length} branch(es) not placed: ${unreached.map((outcome) => `${outcome.lineId} (${outcome.message})`).join('; ')}`,
        unreached.map((outcome) => outcome.lineId),
        unreached.map((outcome) => `branches.${branches.findIndex((branch) => branch.lineId === outcome.lineId)}`),
        branchData,
      );
    const affected = [
      ...best.outcomes.flatMap((outcome) => (outcome.runId === undefined ? [] : [outcome.runId])),
      ...placed.outcomes.flatMap((outcome) => (outcome.runId === undefined ? [] : [outcome.runId])),
    ];
    const passNote = `pass ${transaction.attempts.indexOf(best) + 1} of ${transaction.attempts.length}`;
    return {
      ...changed(
        placed.document,
        `auto_route_lines: routed ${best.routed} of ${asked.length} line(s) in order ${best.order.join(', ')} (${passNote})` +
          (failed.length > 0 ? `; not routed: ${failed.map(detail).join('; ')}` : '') +
          (branches.length > 0
            ? `; branches: ${placed.outcomes.map((o) => (o.runId === undefined ? `${o.lineId} ${o.status}` : `${o.lineId} ${o.runId} on ${o.headerRunId} (${o.fitting})`)).join(', ')}`
            : '') +
          `: ${best.outcomes.flatMap((o) => (o.solution === undefined ? [] : [`${o.runId} ${o.solution.bends} bend(s) ${o.solution.lengthMm} mm`])).join(', ')}.`,
        affected,
      ),
      data: branches.length > 0 ? branchData : data,
    };
  },
});
