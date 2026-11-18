/** Phases of add_pipe_support: input limits, target selection, station planning, element creation, summary. */

import type { BuildingModel, PipeSupportElement } from '@aec/building/types';
import type { CadDocument, Vec3 } from '@core/model/types';
import { isPositiveNumber, isNonNegativeNumber } from '@lib/isFiniteNumber';
import { fromMm } from '@core/model/units';
import { nextElementId, nextMark, withElement } from '../../building/model';
import { toVec3 } from '../common/memberSupport';
import type { ModelUnits, SteelBar } from '../steelDesign/steelMemberBars';
import { nearestOnRoute, pointAtArc, routeLength } from './routeSupport';
import { SAME_SUPPORT_DISTANCE, endCarriers, supportStations, supportsOfPipe, type PipeRun } from './pipeSupportLayout';
import { autoSupportArcs, isPlaceable } from './pipeSupportPlacement';
import { spanWarnings, steelCrossingArcs } from './pipeSupportSnap';
import { pipeSpanLimit } from './pipeSpans';
import { isRunCarrier } from './pipeCarrier';
import { getPiping } from '../../plant/piping/model';
import { PLAN_TOLERANCE, REACH, attachmentFields, clean, isRiserPoint, resolveBearing } from './pipeSupportAttach';

const SNAP_DISTANCE = 500;
const MAX_SUPPORTS_PER_RUN = 500;

type Limits = Parameters<typeof steelCrossingArcs>[3];
type SupportType = PipeSupportElement['type'];

export interface Wanted {
  readonly run: PipeRun;
  readonly arc: number;
}

export interface Plan {
  readonly wanted: Wanted[];
  readonly skipped: string[];
  readonly snappedRuns: Map<string, PipeRun>;
}

export interface Resolved {
  readonly limits: Limits;
  readonly snapDistance: number;
  readonly unit: number;
}

/** The effective reach limits and snap distance (mm), or why the numbers are refused. */
export function resolveLimits(
  doc: CadDocument,
  type: SupportType,
  spacing: number | undefined,
  given: {
    readonly maxReach?: number | undefined;
    readonly planTolerance?: number | undefined;
    readonly snapDistance?: number | undefined;
  },
): Resolved | string {
  const below = type !== 'hanger';
  const unit = fromMm(doc, 1);
  const limits = {
    maxReach: (given.maxReach ?? fromMm(doc, REACH[below ? 'below' : 'above'])) / unit,
    planTolerance: (given.planTolerance ?? fromMm(doc, PLAN_TOLERANCE)) / unit,
  };
  const snapDistance = (given.snapDistance ?? fromMm(doc, SNAP_DISTANCE)) / unit;
  const positive = [spacing ?? 1, limits.maxReach, snapDistance];
  if (!positive.every(isPositiveNumber) || !isNonNegativeNumber(limits.planTolerance))
    return 'spacing, maxReach and snapDistance must be > 0 and planTolerance >= 0.';
  return { limits, snapDistance, unit };
}

export interface Selector {
  readonly pipeId: string | undefined;
  readonly runId: string | undefined;
  readonly line: string | undefined;
}

/** The pipes / runs the command acts on, or why none can be used. */
export function selectTargets(
  doc: CadDocument,
  units: ModelUnits,
  runs: readonly PipeRun[],
  selector: Selector,
  spacing: number | undefined,
  at: readonly (readonly number[])[] | undefined,
  unit: number,
): PipeRun[] | string {
  const { pipeId, runId, line } = selector;
  const { building } = units;
  const isRun = (run: PipeRun): boolean => isRunCarrier(doc, building, run.element.id);
  const targets =
    pipeId !== undefined
      ? runs.filter((run) => run.element.id === pipeId && !isRun(run))
      : runId !== undefined
        ? runs.filter((run) => run.element.id === runId && isRun(run))
        : runs.filter((run) => run.element.line === line?.trim());
  if (targets.length === 0) {
    return pipeId !== undefined
      ? `'${pipeId}' is not a pipe element (add_pipe_run; a spec-driven run is selected with runId).`
      : runId !== undefined
        ? `'${runId}' is not a pipe run (route_pipe).`
        : `no pipe or run carries line '${line ?? ''}'.`;
  }
  const broken = targets.find((run) => isRun(run) && getPiping(doc).runs[run.element.id]?.broken !== undefined);
  if (broken)
    return `run ${broken.element.id} is broken (${getPiping(doc).runs[broken.element.id]?.broken?.reason ?? ''}): repair it first (edit_route, or move the equipment back).`;
  const homeless = targets.find((run) => building.levels[run.element.levelId] === undefined);
  if (homeless) return `${homeless.element.mark} has no building level to hold its supports (add_level first).`;
  if (spacing !== undefined) {
    const spacingMm = spacing / unit;
    const crowded = targets.find((run) => routeLength(run.points) / spacingMm > MAX_SUPPORTS_PER_RUN);
    if (crowded) {
      return `spacing ${spacing} ${doc.units} would put over ${MAX_SUPPORTS_PER_RUN} supports on ${crowded.element.mark} (${Math.round(routeLength(crowded.points) / spacingMm)}); use a larger spacing.`;
    }
  }
  if (at !== undefined && at.length > MAX_SUPPORTS_PER_RUN)
    return `give at most ${MAX_SUPPORTS_PER_RUN} points per call (got ${at.length}).`;
  return targets;
}

/** Station plan from explicit points: each snapped to the nearest target pipe, refused ones recorded in `plan.skipped`. */
export function planFromPoints(
  doc: CadDocument,
  at: readonly (readonly number[])[],
  targets: readonly PipeRun[],
  type: SupportType,
  resolved: Resolved,
  givenSnapDistance: number | undefined,
  plan: Plan,
): void {
  const { unit, snapDistance } = resolved;
  const { wanted, skipped } = plan;
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
        `point [${raw.join(', ')}] is ${best ? Math.round(best.snap.distance * unit * 1000) / 1000 : '?'} from the pipe(s) (snapDistance ${givenSnapDistance ?? fromMm(doc, SNAP_DISTANCE)})`,
      );
    } else if (type === 'hanger' && !isPlaceable(best.run, best.snap.arc)) {
      skipped.push(`point [${raw.join(', ')}] is on a riser (steep segment): a hanger cannot hang there, use a guide, shoe or anchor`);
    } else wanted.push({ run: best.run, arc: best.snap.arc });
  }
}

/** Station plan from a spacing: steel crossings when `snapToSteel`, else (or where none) plain spacing arcs. */
export function planFromSpacing(
  units: ModelUnits,
  targets: readonly PipeRun[],
  runs: readonly PipeRun[],
  bars: ReadonlyArray<SteelBar>,
  type: SupportType,
  resolved: Resolved,
  explicit: SteelBar | undefined,
  snapToSteel: boolean,
  spacing: number,
  plan: Plan,
): void {
  const { wanted, skipped, snappedRuns } = plan;
  for (const run of targets) {
    const existing = supportStations(units, run, supportsOfPipe(units, run.element.id)).map((station) => station.arc);
    const crossings = snapToSteel ? steelCrossingArcs(run, bars, type, resolved.limits, explicit) : [];
    if (crossings.length > 0) {
      snappedRuns.set(run.element.id, run);
      for (const arc of crossings) if (existing.every((other) => Math.abs(other - arc) >= SAME_SUPPORT_DISTANCE)) wanted.push({ run, arc });
      continue;
    }
    if (snapToSteel) skipped.push(`${run.element.mark}: crosses no steel, placed by spacing only`);
    const arcs = autoSupportArcs(run, endCarriers(units, run, runs), existing, spacing / resolved.unit);
    for (const arc of arcs) wanted.push({ run, arc });
  }
}

export interface Placed {
  readonly next: BuildingModel;
  readonly created: PipeSupportElement[];
}

/** Creates the support elements of `plan.wanted`; a string is the refusal of an explicit member that cannot carry a support. */
export function placeSupports(
  doc: CadDocument,
  units: ModelUnits,
  bars: ReadonlyArray<SteelBar>,
  type: SupportType,
  limits: Limits,
  explicit: SteelBar | undefined,
  plan: Plan,
): Placed | string {
  const { wanted, skipped } = plan;
  let next = units.building;
  const created: PipeSupportElement[] = [];
  for (const { run, arc } of wanted) {
    const placed = supportStations(units, run, supportsOfPipe({ ...units, building: next }, run.element.id));
    if (placed.some((station) => Math.abs(station.arc - arc) < SAME_SUPPORT_DISTANCE)) {
      skipped.push(`${run.element.mark} at ${Math.round(arc)} mm: a support is already there`);
      continue;
    }
    const at3 = pointAtArc(run.points, arc);
    if (!at3) continue;
    const riser = isRiserPoint(run.points, at3.point);
    const hit = resolveBearing(bars, type, at3.point, run.diameterMm, limits, riser, explicit);
    if (typeof hit === 'string') return `${hit}; no support was added.`;
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
  return { next, created };
}

/** Span warnings of the runs whose supports were snapped to steel, measured on the layout after creation. */
export function snappedSpanIssues(
  units: ModelUnits,
  next: BuildingModel,
  runs: readonly PipeRun[],
  plan: Plan,
  spacing: number | undefined,
  unit: number,
): string[] {
  const after = { ...units, building: next };
  return [...plan.snappedRuns.values()].flatMap((run) =>
    spanWarnings(
      run,
      supportStations(after, run, supportsOfPipe(after, run.element.id)).map((station) => station.arc),
      endCarriers(after, run, runs),
      (spacing as number) / unit,
      pipeSpanLimit(run.element.dn, run.diameterMm, run.element.service).spanM * 1000,
    ),
  );
}

/** The one-line summary of a finished placement. */
export function supportsSummary(
  units: ModelUnits,
  runs: readonly PipeRun[],
  type: SupportType,
  created: readonly PipeSupportElement[],
  spanIssues: readonly string[],
  skipped: readonly string[],
): string {
  const { building } = units;
  const below = type !== 'hanger';
  const unattached = created.filter((support) => support.memberId === null);
  const marks = created.map((support) => support.mark);
  const pipeMarks = [
    ...new Set(created.map((support) => runs.find((run) => run.element.id === support.pipeId)?.element.mark ?? support.pipeId)),
  ];
  return (
    `Added ${created.length} ${type}(s) ${marks.join(', ')} on pipe ${pipeMarks.join(', ')}` +
    `, bearing on ${[...new Set(created.flatMap((support) => (support.memberId === null ? [] : [building.elements[support.memberId]?.mark ?? support.memberId])))].join(', ') || 'no steel'}` +
    (unattached.length > 0
      ? `; WARNING ${unattached.length} unattached (no steel member ${below ? 'below or beside' : 'above'} the pipe within reach): ${unattached.map((support) => support.mark).join(', ')}`
      : '') +
    (spanIssues.length > 0 ? `; WARNING ${spanIssues.join('; ')}` : '') +
    (skipped.length > 0 ? `; skipped ${skipped.length}: ${skipped.join('; ')}` : '') +
    '.'
  );
}
