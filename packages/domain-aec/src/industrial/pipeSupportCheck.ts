/**
 * check_pipe_supports: support spacing of every pipe against the water-filled steel pipe span table.
 * @layer domain-aec
 */

import type { CadDocument } from '@core/model/types';
import type { CommandResult } from '@core/commands/types';
import { defineCommand, z } from '@core/commands/schema';
import { noop } from '@core/commands/noop';
import { isPositiveNumber, isNonNegativeNumber } from '@lib/isFiniteNumber';
import { getBuilding } from '../model';
import { round } from '../numeric';
import { metres as shown } from './steelMemberRows';
import { toCsv } from '../csv';
import { briefList } from './utilisation';
import { collectSteelBars, modelUnits, type ModelUnits } from './steelMemberBars';
import { spanCoordinate } from './routeSupport';
import { createBeamLoads, type BeamLoads } from './steelBeamLoads';
import { restingArcs } from './steelLineLoads';
import { pipeSpanLimit } from './pipeSpans';
import {
  endCarriers,
  pipeRunsOf,
  supportStations,
  supportsOfPipe,
  isLateralOnly,
  weightSupportsOf,
  type EndCarrier,
  type PipeRun,
} from './pipeSupportLayout';
import { riserRows, type RiserRow } from './pipeSupportRiser';

export interface PipeSupportRow {
  readonly id: string;
  readonly mark: string;
  readonly line: string;
  readonly dn: number;
  readonly lengthM: number;
  /** Table maximum span for the DN, m. */
  readonly maxSpanM: number;
  /** Span limit used = table × spanFactor, m. */
  readonly allowedSpanM: number;
  /** Largest distance between consecutive supports / carried ends, m. */
  readonly largestSpanM: number;
  /** Overhang from the end to the nearest support, m; null where the end is carried. */
  readonly overhangM: { readonly start: number | null; readonly end: number | null };
  /** Supports that bear on steel (the pipe's own, else the beams it rests on). */
  readonly supports: number;
  readonly unattached: number;
  readonly basis: 'supports' | 'resting' | 'nozzles' | 'none';
  readonly endCarriers: readonly [EndCarrier | null, EndCarrier | null];
  /** One verdict per riser (steep run of at least 0.5 m); `ok` includes them. */
  readonly risers: RiserRow[];
  readonly ok: boolean;
  readonly issues: string[];
  readonly notes: string[];
}

const ASSUMPTIONS: ReadonlyArray<string> = [
  'Span limits: MSS SP-69 Table 3 / ASME B31.1 Table 121.5 suggested spacing of horizontal, water-filled, standard-wall steel pipe by nominal size (DN25 2.1 m, DN50 3.0 m, DN80 3.7 m, DN100 4.3 m, DN150 5.2 m, DN200 5.8 m, DN250 6.7 m, DN300 7.0 m, DN400 8.2 m, DN600 9.8 m …), multiplied by spanFactor. A pipe without `dn` takes the size of its outside diameter (an untabulated diameter the next smaller size).',
  'Spans are measured along the centreline between consecutive attached supports; vertical risers (slope > 0.7) are not counted — a vertical pipe does not sag, its weight goes to the supports at its ends. A pipe end inside equipment (nozzle) or on another pipe (branch) is carried: it is a support for the span. A free end must have a support within overhangRatio × allowed span (default 0.5: the cantilever moment stays below the simple-span moment).',
  'Supports count when they bear on a steel member (add_pipe_support memberId set); unattached supports carry nothing and fail the pipe. A pipe without supports counts the beams it rests on (underside at top of steel ±10 mm, as check_steel_members) and is marked basis "resting"; a pipe with supports is carried by them only.',
  'Risers (runs of at least 0.5 m steeper than 44° from horizontal, |dz| / length > 0.7) are checked by a design-aid rule, not a quoted code clause: lateral restraints — attached guides and anchors on the riser (add_pipe_support type guide / anchor at a point on it), an end carried by equipment or a header — at most the table span of the DN × spanFactor apart (the MSS SP-69 spacing applied to the vertical length); a free end (elbow) at most overhangRatio × that span from the nearest restraint (a riser between two elbows with no guide may be that long at most); the riser weight (water-filled, standard wall) carried by an end in equipment / on a header (nozzle), a shoe or anchor clamp on the riser, or an attached support of the pipe within overhangRatio × that span along the pipe of one of its elbows (the riser hangs on the elbow like a free end). A guide on a riser carries no weight on the horizontal spans; a shoe or anchor clamp counts as a support at its elbow.',
  'Not covered: pipes with concentrated loads (valves, flanged instruments), insulation, non-water content, sloped lines (use a smaller spanFactor), thermal loops and seismic restraint.',
];

function rowOf(
  units: ModelUnits,
  run: PipeRun,
  runs: ReadonlyArray<PipeRun>,
  beams: ReadonlyArray<BeamLoads>,
  spanFactor: number,
  overhangRatio: number,
): PipeSupportRow {
  const { element } = run;
  const stations = supportStations(units, run, supportsOfPipe(units, element.id));
  const unattached = stations.filter((station) => !station.attached);
  const weightBearing = weightSupportsOf(units, run).length > 0;
  const explicitArcs = stations
    .filter((station) => station.attached && !isLateralOnly(station))
    .map((station) => station.arc);
  const resting = weightBearing ? [] : restingArcs(units, element, beams);
  const arcs = (weightBearing ? explicitArcs : resting).sort((a, b) => a - b);
  const carriers = endCarriers(units, run, runs);
  const basis: PipeSupportRow['basis'] = weightBearing
    ? 'supports'
    : resting.length > 0
      ? 'resting'
      : carriers[0] !== null && carriers[1] !== null
        ? 'nozzles'
        : 'none';
  const limit = pipeSpanLimit(element.dn, run.diameterMm);
  const allowed = limit.spanM * spanFactor;
  const metres = (millimetres: number): number => round(millimetres / 1000, 2);
  const length = spanCoordinate(run.points, run.lengthMm);
  const spans = arcs.map((arc) => spanCoordinate(run.points, arc));
  const stretch = [...(carriers[0] ? [0] : []), ...spans, ...(carriers[1] ? [length] : [])];
  const largest = stretch.reduce(
    (best, arc, index) => Math.max(best, arc - (stretch[index - 1] ?? arc)),
    0,
  );
  const overhang = {
    start: carriers[0] ? null : (spans[0] ?? length),
    end: carriers[1] ? null : length - (spans.at(-1) ?? 0),
  };
  const issues: string[] = [];
  const notes: string[] = [];
  if (arcs.length === 0 && carriers[0] === null && carriers[1] === null) {
    issues.push(`no support: ${shown(length)} m of pipe rest on nothing`);
  }
  if (largest / 1000 > allowed + 1e-9) {
    issues.push(
      `span ${shown(largest)} m exceeds ${allowed.toFixed(2)} m allowed for DN${limit.dn} (table ${limit.spanM} m)`,
    );
  }
  for (const [end, value] of [
    ['start', overhang.start],
    ['end', overhang.end],
  ] as const) {
    if (
      value !== null &&
      (arcs.length > 0 || carriers[0] !== null || carriers[1] !== null) &&
      value / 1000 > allowed * overhangRatio + 1e-9
    ) {
      issues.push(
        `${end} overhang ${shown(value)} m exceeds ${(allowed * overhangRatio).toFixed(2)} m (${overhangRatio} × allowed span)`,
      );
    }
  }
  for (const station of unattached) {
    issues.push(`support ${station.mark} (${station.type}) is attached to no steel member`);
  }
  if (limit.approximated) {
    notes.push(`DN not tabulated: span of DN${limit.dn} used (next smaller size)`);
  }
  if (run.lengthMm - length > 1) {
    notes.push(`risers (${shown(run.lengthMm - length)} m) are not counted in the spans`);
  }
  const risers = riserRows(run, stations, carriers, allowed * 1000, overhangRatio);
  issues.push(...risers.flatMap((riser) => riser.issues));
  if (basis === 'resting') notes.push('no supports: the beams the pipe rests on are used');
  return {
    id: element.id,
    mark: element.mark,
    line: element.line ?? '',
    dn: limit.dn,
    lengthM: metres(run.lengthMm),
    maxSpanM: limit.spanM,
    allowedSpanM: round(allowed, 2),
    largestSpanM: metres(largest),
    overhangM: {
      start: overhang.start === null ? null : metres(overhang.start),
      end: overhang.end === null ? null : metres(overhang.end),
    },
    supports: arcs.length,
    unattached: unattached.length,
    basis,
    endCarriers: carriers,
    risers,
    ok: issues.length === 0,
    issues,
    notes,
  };
}

/**
 * @command check_pipe_supports
 * @pure read-only
 * @affects none; data = { ok, pipes: PipeSupportRow[], totals, csv, assumptions }
 * @invariant every pipe (of the level / line filter) has exactly one row
 * @failure no pipes / unknown level / line without pipes / spanFactor <= 0 / overhangRatio < 0 -> no-op, no data
 */
export const checkPipeSupports = defineCommand({
  name: 'check_pipe_supports',
  annotations: { readOnly: true, idempotent: true },
  description:
    'Read-only support-spacing check of every pipe (add_pipe_run) against the standard maximum span of water-filled ' +
    'standard-wall steel pipe by DN (MSS SP-69 Table 3 / ASME B31.1 Table 121.5: DN25 2.1 m, DN50 3.0 m, DN80 3.7 m, ' +
    "DN100 4.3 m, DN150 5.2 m, DN200 5.8 m, DN250 6.7 m, DN300 7.0 m …). Uses the pipe's add_pipe_support supports " +
    '(only those bearing on steel count), else the beams it rests on. Ends inside equipment (nozzle) or on another pipe ' +
    'are carried; a free end needs a support within overhangRatio × allowed span. Returns data.pipes: one row per pipe ' +
    '{ id, mark, line, dn, lengthM, maxSpanM (table), allowedSpanM (table × spanFactor), largestSpanM (actual), ' +
    'overhangM, supports, unattached, basis ("supports" | "resting" | "nozzles" | "none"), risers, ok, issues, notes }; data.ok is true ' +
    'only when every pipe passes. RISERS (runs ≥ 0.5 m steeper than 44° from horizontal) are checked too: ' +
    'risers[] = { fromZM, toZM, lengthM, guides, maxGuideSpacingM, allowedSpacingM, weightKn, weightBy ("carried end" | ' +
    '"clamp" | "elbow support" | null), ok, issues }; they need lateral guides (add_pipe_support type "guide" at a point on the ' +
    'riser, bracketed to steel beside it) at most the span table value apart and at most overhangRatio × span from a free ' +
    'elbow, and their weight carried by an end in equipment, a shoe / anchor clamp on the riser or a support within overhangRatio × span of an ' +
    'elbow; the pipe ok includes its risers. Fix a failing pipe with add_pipe_support (spacing or at points).',
  params: z.object({
    spanFactor: z
      .number()
      .optional()
      .describe(
        'Multiplier on the table span, > 0, e.g. 0.8 for insulated lines or many valves. Default 1.',
      ),
    overhangRatio: z
      .number()
      .optional()
      .describe(
        'Largest overhang of a free pipe end beyond its last support, as a fraction of the allowed span, ≥ 0. Default 0.5.',
      ),
    line: z.string().optional().describe('Only the pipe(s) with this line number, e.g. "L-101".'),
    levelId: z
      .string()
      .optional()
      .describe('Only the pipes of this level id. Default: every level.'),
  }),
  run: (doc: CadDocument, params): CommandResult => {
    const { spanFactor = 1, overhangRatio = 0.5 } = params;
    if (!isPositiveNumber(spanFactor)) {
      return noop(doc, 'check_pipe_supports failed: spanFactor must be a number > 0.');
    }
    if (!isNonNegativeNumber(overhangRatio)) {
      return noop(doc, 'check_pipe_supports failed: overhangRatio must be a number >= 0.');
    }
    const building = getBuilding(doc);
    if (params.levelId !== undefined && !building.levels[params.levelId]) {
      return noop(doc, `check_pipe_supports failed: no level '${params.levelId}'.`);
    }
    const units = modelUnits(doc);
    const runs = pipeRunsOf(units);
    const selected = runs.filter(
      ({ element }) =>
        (params.levelId === undefined || element.levelId === params.levelId) &&
        (params.line === undefined || element.line === params.line.trim()),
    );
    if (selected.length === 0) {
      return noop(
        doc,
        runs.length === 0
          ? 'check_pipe_supports failed: the model has no pipes (add_pipe_run).'
          : 'check_pipe_supports failed: no pipe matches the level / line filter.',
      );
    }
    const beams = collectSteelBars(doc)
      .filter((bar) => bar.kind === 'beam')
      .map(createBeamLoads);
    const pipes = selected.map((run) => rowOf(units, run, runs, beams, spanFactor, overhangRatio));
    const failing = pipes.filter((row) => !row.ok);
    const unattached = pipes.reduce((sum, row) => sum + row.unattached, 0);
    const csv = toCsv(
      [
        'Mark',
        'Line',
        'DN',
        'Length (m)',
        'Allowed span (m)',
        'Largest span (m)',
        'Supports',
        'Status',
        'Issues',
      ],
      pipes.map((row) => [
        row.mark,
        row.line,
        `DN${row.dn}`,
        row.lengthM,
        row.allowedSpanM,
        row.largestSpanM,
        row.supports,
        row.ok ? 'OK' : 'FAIL',
        row.issues.join('; '),
      ]),
    );
    const list = briefList(
      failing,
      (row) => `${row.mark}${row.line === '' ? '' : ` ${row.line}`} (${row.issues[0] ?? ''})`,
    );
    return {
      document: doc,
      summary:
        `Pipe support check (span table × ${spanFactor}): ${pipes.length} pipe(s), ${pipes.length - failing.length} ok` +
        (failing.length === 0 ? '' : `, ${failing.length} failing: ${list}`) +
        (unattached > 0 ? `; ${unattached} unattached support(s)` : '') +
        '.',
      affected: [],
      data: {
        ok: failing.length === 0,
        pipes,
        failures: failing.map((row) => row.id),
        totals: {
          pipes: pipes.length,
          ok: pipes.length - failing.length,
          failing: failing.length,
          supports: pipes.reduce((sum, row) => sum + row.supports, 0),
          unattached,
        },
        spanFactor,
        overhangRatio,
        csv,
        assumptions: ASSUMPTIONS,
      },
    };
  },
});
