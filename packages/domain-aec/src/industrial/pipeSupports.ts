/**
 * Pipe supports: shoes / guides / anchors on steel below, hangers from steel above.
 * @layer domain-aec
 */

import type { PipeSupportElement } from '@core/model/building';
import type { Vec3 } from '@core/model/types';
import type { CommandResult } from '@core/commands/types';
import { defineCommand, z } from '@core/commands/schema';
import { noop } from '@core/commands/noop';
import { isPositiveNumber, isNonNegativeNumber } from '@lib/isFiniteNumber';
import { fromMm, nextElementId, nextMark, elementAffected, withElement } from '../model';
import { regenerateBuilding } from '../evaluateElements';
import { toVec3 } from './memberSupport';
import { modelUnits, collectSteelBars } from './steelMemberBars';
import { nearestOnRoute, pointAtArc, routeLength } from './routeSupport';
import {
  SAME_SUPPORT_DISTANCE,
  endCarriers,
  pipeRunsOf,
  supportStations,
  supportsOfPipe,
  type PipeRun,
} from './pipeSupportLayout';
import { autoSupportArcs, isPlaceable } from './pipeSupportPlacement';
import {
  PLAN_TOLERANCE,
  REACH,
  attachmentFields,
  clean,
  isRiserPoint,
  resolveBearing,
} from './pipeSupportAttach';

const SUPPORT_TYPES = ['shoe', 'hanger', 'guide', 'anchor'] as const;
const SNAP_DISTANCE = 500;
const MAX_SUPPORTS_PER_RUN = 500;

/**
 * @command add_pipe_support
 * @pure
 * @affects creates one pipe support element per position (block / rod geometry on layer P-SUPP), in model order
 * @invariant supports of a pipe are never closer than 100 mm; a support with no steel found is stored unattached (memberId null)
 * @failure unknown pipe / line, neither or both of `at` and `spacing`, bad numbers, unknown or unsuitable memberId, no valid position -> no-op
 */
export const addPipeSupport = defineCommand({
  name: 'add_pipe_support',
  description:
    'Place supports on an existing pipe (add_pipe_run) so its weight reaches the steel (check_steel_members) and ' +
    'its spans can be verified (check_pipe_supports). Select the pipe with `pipeId` (element id) or `line` ' +
    '(line number, every pipe carrying it) and give EITHER `at` (list of absolute [x, y, z] points, each snapped ' +
    'to the nearest point of the pipe centreline within `snapDistance`) OR `spacing` (auto-placed along the ' +
    'pipe at no more than that spacing, plus one support min(300 mm, spacing/4) from each free end and one near ' +
    'each bend; ends inside equipment or on another pipe are carried and get none; never on risers). ' +
    '`type`: "shoe" (pipe rests on steel below), "hanger" (rod from steel above), "guide" (shoe with side stops), ' +
    '"anchor" (shoe fixed to the steel); all four carry the pipe weight on a horizontal run. ON A RISER (a ' +
    'segment steeper than 44° from horizontal, |dz|/length > 0.7; give an `at` point on it, `spacing` never places ' +
    'there) only guide / shoe / anchor are allowed and they are clamps with a horizontal bracket to steel BESIDE ' +
    'the pipe: a guide restrains it laterally (checked by check_pipe_supports riser rule: lateral restraint spacing ' +
    'and a support carrying the riser weight), a shoe or anchor also carries the riser weight (an anchor is a guide ' +
    'and a weight support). The steel it bears on is `memberId` ' +
    'or the nearest steel member in the right direction (below for shoe / guide / anchor, above for a hanger) ' +
    'within `maxReach` vertically and within half its width + `planTolerance` in plan (riser: a column, or a ' +
    'horizontal member whose section reaches the clamp elevation ± planTolerance, with its face within `maxReach` ' +
    'horizontally of the pipe surface). A position with no steel ' +
    'in reach is still created but UNATTACHED (memberId null): it carries nothing and the summary warns. ' +
    'Supports follow their pipe (moved, copied, deleted with it) and follow edits of their steel: deleting or ' +
    'moving a member or moving the pipe re-attaches them to the nearest steel in reach, or leaves them unattached ' +
    "(the edit command's summary lists which). Marks PS1, PS2… " +
    'data.supports lists { id, mark, pipeId, type, position (level-relative), memberId, rodLength, standoff (riser bracket length) }.',
  params: z.object({
    pipeId: z
      .string()
      .optional()
      .describe(
        'Element id of the pipe, e.g. "pipe-3" (from add_pipe_run data.elementId). Or use `line`.',
      ),
    line: z
      .string()
      .optional()
      .describe(
        'Line number of the pipe(s), e.g. "L-101" (the `line` given to add_pipe_run). Or use `pipeId`.',
      ),
    at: z
      .array(z.array(z.number()))
      .optional()
      .describe(
        'Absolute support points [[x, y, z], …] in document units (z = elevation, not level-relative), on or near ' +
          'the pipe centreline: each is snapped to the nearest point of the pipe. Give this OR `spacing`.',
      ),
    spacing: z
      .number()
      .optional()
      .describe(
        'Maximum distance between supports along the pipe, document units, > 0: supports are auto-placed along ' +
          'the pipe (also near free ends and bends). Give this OR `at`. Existing supports are kept and counted.',
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
    snapDistance: z
      .number()
      .optional()
      .describe(
        'Largest distance from an `at` point to the pipe centreline, document units, > 0. Default 500 mm.',
      ),
  }),
  run: (doc, params): CommandResult => {
    const { pipeId, line, at, spacing, memberId, type = 'shoe' } = params;
    const fail = (reason: string): CommandResult => noop(doc, `add_pipe_support failed: ${reason}`);
    if ((pipeId === undefined) === (line === undefined)) {
      return fail('give exactly one of pipeId or line.');
    }
    if ((at === undefined) === (spacing === undefined)) {
      return fail('give exactly one of at (list of points) or spacing.');
    }
    const below = type !== 'hanger';
    const unit = fromMm(doc, 1);
    const limits = {
      maxReach: (params.maxReach ?? fromMm(doc, REACH[below ? 'below' : 'above'])) / unit,
      planTolerance: (params.planTolerance ?? fromMm(doc, PLAN_TOLERANCE)) / unit,
    };
    const snapDistance = (params.snapDistance ?? fromMm(doc, SNAP_DISTANCE)) / unit;
    const positive = [spacing ?? 1, limits.maxReach, snapDistance];
    if (!positive.every(isPositiveNumber) || !isNonNegativeNumber(limits.planTolerance)) {
      return fail('spacing, maxReach and snapDistance must be > 0 and planTolerance >= 0.');
    }
    const units = modelUnits(doc);
    const { building } = units;
    const runs = pipeRunsOf(units);
    const targets =
      pipeId !== undefined
        ? runs.filter((run) => run.element.id === pipeId)
        : runs.filter((run) => run.element.line === line?.trim());
    if (targets.length === 0) {
      return fail(
        pipeId !== undefined
          ? `'${pipeId}' is not a pipe element (add_pipe_run).`
          : `no pipe carries line '${line ?? ''}'.`,
      );
    }
    if (spacing !== undefined) {
      const spacingMm = spacing / unit;
      const crowded = targets.find(
        (run) => routeLength(run.points) / spacingMm > MAX_SUPPORTS_PER_RUN,
      );
      if (crowded) {
        return fail(
          `spacing ${spacing} ${doc.units} would put over ${MAX_SUPPORTS_PER_RUN} supports on ${crowded.element.mark} (${Math.round(routeLength(crowded.points) / spacingMm)}); use a larger spacing.`,
        );
      }
    }
    if (at !== undefined && at.length > MAX_SUPPORTS_PER_RUN) {
      return fail(`give at most ${MAX_SUPPORTS_PER_RUN} points per call (got ${at.length}).`);
    }
    const bars = collectSteelBars(doc);
    const explicit = memberId === undefined ? undefined : bars.find((bar) => bar.id === memberId);
    if (memberId !== undefined && !explicit) {
      return fail(`memberId '${memberId}' is not a steel member.`);
    }
    const wanted: Array<{ run: PipeRun; arc: number }> = [];
    const skipped: string[] = [];
    if (at !== undefined) {
      for (const raw of at) {
        const point = raw.length === 3 ? toVec3(raw) : null;
        if (point === null) {
          skipped.push(`point [${raw.join(', ')}] is not [x, y, z]`);
          continue;
        }
        const world: Vec3 = [point[0] / unit, point[1] / unit, point[2] / unit];
        const snaps = targets.flatMap((run) => {
          const snap = nearestOnRoute(run.points, world);
          return snap ? [{ run, snap }] : [];
        });
        const best = snaps.sort((a, b) => a.snap.distance - b.snap.distance)[0];
        if (!best || best.snap.distance > snapDistance) {
          skipped.push(
            `point [${raw.join(', ')}] is ${best ? Math.round(best.snap.distance * unit * 1000) / 1000 : '?'} from the pipe(s) (snapDistance ${params.snapDistance ?? fromMm(doc, SNAP_DISTANCE)})`,
          );
        } else if (type === 'hanger' && !isPlaceable(best.run, best.snap.arc)) {
          skipped.push(
            `point [${raw.join(', ')}] is on a riser (steep segment): a hanger cannot hang there, use a guide, shoe or anchor`,
          );
        } else wanted.push({ run: best.run, arc: best.snap.arc });
      }
    } else {
      for (const run of targets) {
        const existing = supportStations(units, run, supportsOfPipe(units, run.element.id)).map(
          (station) => station.arc,
        );
        const arcs = autoSupportArcs(
          run,
          endCarriers(units, run, runs),
          existing,
          (spacing as number) / unit,
        );
        for (const arc of arcs) wanted.push({ run, arc });
      }
    }
    let next = building;
    const created: PipeSupportElement[] = [];
    for (const { run, arc } of wanted) {
      const placed = supportStations(
        units,
        run,
        supportsOfPipe({ ...units, building: next }, run.element.id),
      );
      if (placed.some((station) => Math.abs(station.arc - arc) < SAME_SUPPORT_DISTANCE)) {
        skipped.push(`${run.element.mark} at ${Math.round(arc)} mm: a support is already there`);
        continue;
      }
      const at3 = pointAtArc(run.points, arc);
      if (!at3) continue;
      const riser = isRiserPoint(run.points, at3.point);
      const hit = resolveBearing(bars, type, at3.point, run.diameterMm, limits, riser, explicit);
      if (typeof hit === 'string') {
        return fail(`${hit}; no support was added.`);
      }
      const support: PipeSupportElement = {
        id: nextElementId(next, 'pipeSupport'),
        category: 'pipeSupport',
        mark: nextMark(next, 'pipeSupport'),
        entityIds: [],
        levelId: run.element.levelId,
        pipeId: run.element.id,
        type,
        position: [
          clean(fromMm(doc, at3.point[0])),
          clean(fromMm(doc, at3.point[1])),
          clean(fromMm(doc, at3.point[2] - units.elevationMm(run.element.levelId))),
        ],
        ...attachmentFields(doc, type, hit),
      };
      next = withElement(next, support);
      created.push(support);
    }
    if (created.length === 0) {
      return fail(
        `no support could be placed${skipped.length > 0 ? ` (${skipped.join('; ')})` : ''}.`,
      );
    }
    const document = regenerateBuilding(doc, next);
    const unattached = created.filter((support) => support.memberId === null);
    const marks = created.map((support) => support.mark);
    const pipeMarks = [
      ...new Set(created.map((support) => building.elements[support.pipeId]?.mark)),
    ];
    return {
      document,
      summary:
        `Added ${created.length} ${type}(s) ${marks.join(', ')} on pipe ${pipeMarks.join(', ')}` +
        `, bearing on ${[...new Set(created.flatMap((support) => (support.memberId === null ? [] : [building.elements[support.memberId]?.mark ?? support.memberId])))].join(', ') || 'no steel'}` +
        (unattached.length > 0
          ? `; WARNING ${unattached.length} unattached (no steel member ${below ? 'below or beside' : 'above'} the pipe within reach): ${unattached.map((support) => support.mark).join(', ')}`
          : '') +
        (skipped.length > 0 ? `; skipped ${skipped.length}: ${skipped.join('; ')}` : '') +
        '.',
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
        skipped,
      },
    };
  },
});
