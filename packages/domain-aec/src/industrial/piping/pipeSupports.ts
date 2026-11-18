/** Pipe supports: shoes / guides / anchors on steel below, hangers from steel above. */

import type { CommandResult } from '@core/commands/types';
import { defineCommand, z } from '@core/commands/schema';
import { failedWith } from '@core/commands/noop';
import { elementAffected } from '../../building/model';
import { regenerateBuilding } from '../../building/evaluate/evaluateElements';
import { modelUnits, collectSteelBars } from '../steelDesign/steelMemberBars';
import { pipeRunsOf, type PipeRun } from './pipeSupportLayout';
import {
  placeSupports,
  planFromPoints,
  planFromSpacing,
  resolveLimits,
  selectTargets,
  snappedSpanIssues,
  supportsSummary,
  type Plan,
} from './pipeSupportsPlan';

const SUPPORT_TYPES = ['shoe', 'hanger', 'guide', 'anchor'] as const;

/**
 * @affects creates one pipe support element per position (block / rod geometry on layer P-SUPP), in model order
 * @invariant supports of a pipe are never closer than 100 mm; a support with no steel found is stored unattached (memberId null)
 * @failure unknown pipe / line, neither or both of `at` and `spacing`, bad numbers, unknown or unsuitable memberId, no valid position ->
 * no-op
 */
export const addPipeSupport = defineCommand({
  name: 'add_pipe_support',
  description:
    'Place supports on an existing pipe (add_pipe_run) or on a spec-driven run (route_pipe: pass `runId`, the support follows the run centreline of piping_takeoff.legs) so its weight reaches the steel (check_steel_members) and its spans can be ' +
    'verified (check_pipe_supports, which reads both pipe kinds). Select the pipe with `pipeId` (building pipe element id), `runId` (plant run id) or `line` (line number, every pipe and run carrying it) and give ' +
    'EITHER `at` (list of absolute [x, y, z] points, each snapped to the nearest point of the pipe centreline within `snapDistance`) OR ' +
    '`spacing` (auto-placed along the pipe at no more than that spacing, plus one support min(300 mm, spacing/4) from each free end and ' +
    'one near each bend; ends inside equipment or on another pipe are carried and get none; never on risers). `type`: "shoe" (pipe rests ' +
    'on steel below), "hanger" (rod from steel above), "guide" (shoe with side stops), "anchor" (shoe fixed to the steel); all four ' +
    'carry the pipe weight on a horizontal run. ON A RISER (a segment steeper than 44° from horizontal, |dz|/length > 0.7; give an `at` ' +
    'point on it, `spacing` never places there) only guide / shoe / anchor are allowed and they are clamps with a horizontal bracket to ' +
    'steel BESIDE the pipe: a guide restrains it laterally (checked by check_pipe_supports riser rule: lateral restraint spacing and a ' +
    'support carrying the riser weight), a shoe or anchor also carries the riser weight (an anchor is a guide and a weight support). The ' +
    'steel it bears on is `memberId` or the nearest steel member in the right direction (below for shoe / guide / anchor, above for a ' +
    'hanger) within `maxReach` vertically and within half its width + `planTolerance` in plan (riser: a column, or a horizontal member ' +
    'whose section reaches the clamp elevation ± planTolerance, with its face within `maxReach` horizontally of the pipe surface). A ' +
    'position with no steel in reach is still created but UNATTACHED (memberId null): it carries nothing and the summary warns. Supports ' +
    'follow their pipe (moved, copied, deleted with it) and follow edits of their steel: deleting or moving a member or moving the pipe ' +
    "re-attaches them to the nearest steel in reach, or leaves them unattached (the edit command's summary lists which). The supports of a plant run follow its " +
    'stretch (equipment moved) and edit_route: each is re-snapped to the nearest point of the new centreline and re-attached to steel, and the edit summary lists the ones moved, re-attached or left in place; a run needs a building level (add_level) to hold them (the highest level whose elevation is at or below the lowest point of its centreline, else the lowest level), and a broken run is refused. A support whose pipe or run is later gone stays in place and is reported by check_pipe_supports as RTE_SUPPORT_ORPHAN. Marks PS1, ' +
    'PS2… data.supports lists { id, mark, pipeId, type, position (level-relative), memberId, rodLength, standoff (riser bracket length) ' +
    '}.',
  params: z.object({
    pipeId: z
      .string()
      .optional()
      .describe('Element id of the building pipe, e.g. "pipe-3" (from add_pipe_run data.elementId). Or use `runId` or `line`.'),
    runId: z
      .string()
      .optional()
      .describe('Id of a spec-driven pipe run, e.g. "run-4" (affected[0] of route_pipe). Or use `pipeId` or `line`.'),
    line: z
      .string()
      .optional()
      .describe(
        'Line number of the pipe(s) and run(s), e.g. "L-101" (the `line` given to add_pipe_run, or the lineNumber of create_pipeline). Or use `pipeId` / `runId`.',
      ),
    at: z
      .array(z.array(z.number()))
      .optional()
      .describe(
        'Absolute support points [[x, y, z], …] in document units (z = elevation, not level-relative), on or near the pipe centreline: ' +
          'each is snapped to the nearest point of the pipe. At most 500 points per call. Give this OR `spacing`.',
      ),
    spacing: z
      .number()
      .optional()
      .describe(
        'Maximum distance between supports along the pipe, document units, > 0: supports are auto-placed along ' +
          'the pipe (also near free ends and bends); refused when pipe length / spacing exceeds 500 supports on a run. ' +
          'Give this OR `at`. Existing supports are kept and counted. Where the pipe crosses steel the supports go on that steel and this ' +
          'is the maximum allowed span (see `snapToSteel`, default on).',
      ),
    type: z
      .enum(SUPPORT_TYPES)
      .optional()
      .describe(
        '"shoe" (rests on steel below, default), "hanger" (rod from steel above), "guide" (shoe with side stops; on a riser a lateral guide clamp) or "anchor" (fixed shoe; on a riser a clamp that guides and carries the weight).',
      ),
    memberId: z
      .string()
      .optional()
      .describe(
        'Element id of the steel member (add_steel_member data.elementId) every support bears on. Default: the ' +
          'nearest member in reach for each support.',
      ),
    maxReach: z
      .number()
      .optional()
      .describe(
        'Largest vertical gap between the pipe and its steel, document units, > 0: pedestal height for shoe / ' +
          'guide / anchor (default 500 mm), rod length for a hanger (default 3000 mm); on a riser the largest ' +
          'horizontal gap from the pipe surface to the member face (default 500 mm).',
      ),
    planTolerance: z
      .number()
      .optional()
      .describe(
        'Plan distance allowed beyond half the member width between the support and the member axis, document units, ≥ 0. Default 100 mm.',
      ),
    snapToSteel: z
      .boolean()
      .optional()
      .describe(
        'With `spacing`: put the supports where the pipe crosses steel (one at each beam / member the centreline passes over or under, ' +
          'bearing on it) and treat `spacing` as the MAXIMUM allowed span between supports: no support is added away from steel, and the ' +
          'summary (data.spanWarnings) warns about every span longer than `spacing` or than the pipe-size table span, and every free end ' +
          'overhanging by more than half the spacing. A member running alongside the pipe is not a crossing. Pipes crossing no steel ' +
          'fall back to plain spacing placement (unattached supports, warned). Default true; false = plain spacing placement only. ' +
          'Ignored with `at`.',
      ),
    snapDistance: z
      .number()
      .optional()
      .describe('Largest distance from an `at` point to the pipe centreline, document units, > 0. Default 500 mm.'),
  }),
  run: (doc, params): CommandResult => {
    const { pipeId, runId, line, at, spacing, memberId, type = 'shoe', snapToSteel = true } = params;
    const fail = failedWith(doc, 'add_pipe_support');
    if ([pipeId, runId, line].filter((value) => value !== undefined).length !== 1)
      return fail('give exactly one of pipeId, runId or line.');
    if ((at === undefined) === (spacing === undefined)) return fail('give exactly one of at (list of points) or spacing.');
    const resolved = resolveLimits(doc, type, spacing, params);
    if (typeof resolved === 'string') return fail(resolved);
    const { limits, unit } = resolved;
    const units = modelUnits(doc);
    const runs = pipeRunsOf(units);
    const targets = selectTargets(doc, units, runs, { pipeId, runId, line }, spacing, at, unit);
    if (typeof targets === 'string') return fail(targets);
    const bars = collectSteelBars(doc);
    const explicit = memberId === undefined ? undefined : bars.find((bar) => bar.id === memberId);
    if (memberId !== undefined && !explicit) return fail(`memberId '${memberId}' is not a steel member.`);
    const plan: Plan = { wanted: [], skipped: [], snappedRuns: new Map<string, PipeRun>() };
    if (at !== undefined) planFromPoints(doc, at, targets, type, resolved, params.snapDistance, plan);
    else planFromSpacing(units, targets, runs, bars, type, resolved, explicit, snapToSteel, spacing as number, plan);
    const placed = placeSupports(doc, units, bars, type, limits, explicit, plan);
    if (typeof placed === 'string') return fail(placed);
    const { next, created } = placed;
    const { skipped } = plan;
    if (created.length === 0) return fail(`no support could be placed${skipped.length > 0 ? ` (${skipped.join('; ')})` : ''}.`);
    const document = regenerateBuilding(doc, next);
    const unattached = created.filter((support) => support.memberId === null);
    const spanIssues = snappedSpanIssues(units, next, runs, plan, spacing, unit);
    return {
      document,
      summary: supportsSummary(units, runs, type, created, spanIssues, skipped),
      affected: elementAffected(
        document,
        created.map((support) => support.id),
      ),
      data: {
        elementIds: created.map((support) => support.id),
        supports: created.map((support) => ({
          id: support.id,
          mark: support.mark,
          pipeId: support.pipeId,
          type: support.type,
          position: support.position,
          memberId: support.memberId,
          rodLength: support.rodLength,
          standoff: support.standoff ?? 0,
        })),
        unattached: unattached.map((support) => support.id),
        spanWarnings: spanIssues,
        skipped,
      },
    };
  },
});
