/**
 * `route_pipe` starting on an existing run (plant 02 RTE, CAT-FU): the branch off a header in one transaction. The start is `{ onRun: { runId, at } }`;
 * the command runs the `add_branch` derivation (the tee, olet or stub-in the header spec's branch table gives for the pair of sizes) with the line of the
 * route and its size, and answers as `route_pipe` (the new run is the branch run).
 * @invariant pure; one document result: the header, the branch point and the branch run are created together or not at all
 */

import { vec3, z } from '@core/commands/schema';
import type { ExecutionContext, CommandResult } from '@core/commands/types';
import type { CadDocument } from '@core/model/types';
import { addBranch } from './addBranch';
import { refuse } from '../model';

/** Where the branch leaves the header, as `add_branch.at`. */
export const branchOnRun = z.object({
  runId: z.string().min(1).describe('Header run id (an existing run: affected[0] of route_pipe / auto_route_pipe / add_branch).'),
  at: z
    .union([
      z.object({ point: vec3('A point [x, y, z] on the header centreline, within 0.01 mm.') }),
      z.object({
        leg: z.number().int().min(0).describe('Header leg index.'),
        distance: z.number().positive().describe('Distance of the branch point from the leg start, mm.'),
      }),
    ])
    .describe('Where the branch leaves the header: { point } on the centreline or { leg, distance }.'),
});

interface BranchRouteParams {
  readonly lineId: string;
  readonly legs?: Parameters<typeof addBranch.run>[1]['legs'];
  readonly via?: Parameters<typeof addBranch.run>[1]['via'];
  readonly to?: Parameters<typeof addBranch.run>[1]['to'];
  readonly bendRadius?: number | undefined;
  readonly angleToleranceDeg?: number | undefined;
  readonly inline?: readonly unknown[] | undefined;
}

/**
 * The route of line `params.lineId` as a branch of `onRun.runId`.
 * @failure inline / bendRadius (not available on a branch start) -> RTE_INLINE_DOES_NOT_FIT / RTE_NO_FITTING_FOR_ANGLE; otherwise the add_branch refusals
 */
export function branchFromRun(
  doc: CadDocument,
  params: BranchRouteParams,
  onRun: z.output<typeof branchOnRun>,
  lineDn: number,
  ctx: ExecutionContext | undefined,
): CommandResult {
  if (params.inline !== undefined && params.inline.length > 0)
    return refuse(
      doc,
      'route_pipe',
      'RTE_INLINE_DOES_NOT_FIT',
      'inline components are not placed while branching: route the branch, then insert_inline_component on data.runId',
      [],
      ['inline'],
    );
  if (params.bendRadius !== undefined)
    return refuse(
      doc,
      'route_pipe',
      'RTE_NO_FITTING_FOR_ANGLE',
      'bendRadius is not available on a branch start: use the spec bendRadiusD or a spec elbow',
      [],
      ['bendRadius'],
    );
  const result = addBranch.run(
    doc,
    {
      runId: onRun.runId,
      at: onRun.at,
      dn: lineDn,
      lineId: params.lineId,
      ...(params.to === undefined ? {} : { to: params.to }),
      ...(params.legs === undefined ? {} : { legs: params.legs }),
      ...(params.via === undefined ? {} : { via: params.via }),
      ...(params.angleToleranceDeg === undefined ? {} : { angleToleranceDeg: params.angleToleranceDeg }),
    },
    ctx,
  );
  if (result.rejected === true) return { ...result, summary: result.summary.replace(/^add_branch/, 'route_pipe') };
  const data = result.data as Record<string, unknown>;
  return {
    ...result,
    summary: result.summary.replace(/^add_branch/, 'route_pipe (branch)'),
    data: { ...data, runId: data['branchRunId'] },
  };
}
