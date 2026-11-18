/** One leg of a run derivation: the intervals at its ends, the pipe pieces and fittings stacked along it, the branch olets on it, its record and the elbow after it. */

import type { Vec3 } from '@core/model/vectors';
import type { Joint } from '@aec/plant/types';
import { add3, scale3 } from '@lib/vec3';
import { fail, isFailure, type DerivationFailure, type DerivationWarning, type DerivedLeg, type DerivedTurn } from './deriveTypes';
import type { Join } from './connections';
import type { ElbowChoice } from './fittings';
import { stackLeg, defaultMinWeldSpacing, type Interval, type Piece, type Stack, type StackWarning } from './jointStack';
import { directionLabel } from './legs';
import { isSloped, legFall } from './slope';
import { oletPart } from './routeBranch';
import { at, partOf, type Slot } from './routeEnv';
import { turnPartFields } from './routeTurns';
import type { RunCtx } from './routeRunCtx';
import { dnAfter } from './runSizes';

const BRANCH_KINDS: ReadonlySet<string> = new Set(['olet', 'stubIn']);

interface LegPiece {
  readonly id: string;
  readonly start: number;
  readonly end: number;
}

interface LegWalk {
  readonly leg: number;
  readonly u: Vec3;
  readonly origin: Vec3;
  readonly head: Interval;
  readonly slotById: ReadonlyMap<string, Slot>;
  readonly weld: Joint['kind'];
  readonly cuts: number[];
  readonly pieces: LegPiece[];
  sideways: Vec3;
  dnHere: number;
}

/** Plan length, drop and slope angle of a sloped leg, rounded to micrometres / micro-degrees (float noise out of the answers). */
function slopeFields(u: Vec3, length: number): Pick<DerivedLeg, 'planLengthMm' | 'dropMm' | 'slopeDeg'> {
  const fall = legFall(u, length);
  const round = (value: number): number => Math.round(value * 1e6) / 1e6;
  return { planLengthMm: round(fall.planLengthMm), dropMm: round(fall.dropMm), slopeDeg: round(fall.slopeDeg) };
}

/** The kind, root gap and engagement of the joint between the pipe and interval `side` (a butt weld of gap `side.gap` unless the interval has a join). */
function jointOf(side: Interval, butt: Joint['kind']): Pick<Joint, 'kind' | 'gapMm' | 'engagementMm'> {
  const join = side.join;
  if (join === undefined) return { kind: butt, gapMm: side.gap };
  return { kind: join.joint, gapMm: join.rootGapMm, ...(join.engagementMm > 0 ? { engagementMm: join.engagementMm } : {}) };
}

/** Warning record of a stack warning on leg `leg`. */
function warningOf(warning: StackWarning, runId: string, leg: number): DerivationWarning {
  const ids = [warning.from, warning.to].filter((id) => id.startsWith(`${runId}/`));
  const message =
    warning.code === 'RTE_WELD_SPACING'
      ? `leg ${leg}: pipe piece of ${+warning.cutLengthMm.toFixed(4)} mm is shorter than the weld spacing ${warning.minimumMm} mm (named default max(4 t, 50 mm))`
      : `leg ${leg}: ${warning.from} and ${warning.to} touch (zero cut length)`;
  return { code: warning.code, ids, message, detail: { leg, cutLengthMm: warning.cutLengthMm, minimumMm: warning.minimumMm ?? null } };
}

function headInterval(c: RunCtx, leg: number, shift: number): Interval {
  if (leg === 0) {
    const side = c.start;
    return {
      id: c.startIds?.flange ?? c.startCapId ?? side.fittingId ?? side.portId ?? 'open:start',
      start: 0,
      end: side.length,
      gap: side.gap,
      kind: 'fitting',
      ...(side.join === undefined ? {} : { join: side.join }),
    };
  }
  return {
    id: `${c.env.run.id}/elbow-${leg}`,
    start: shift,
    end: shift + (c.chosen.elbows[leg - 1] as ElbowChoice).centreToEnd,
    gap: (c.chosen.joins[leg - 1] as Join).gapMm,
    kind: 'fitting',
    join: c.chosen.joins[leg - 1] as Join,
  };
}

function tailInterval(c: RunCtx, leg: number, length: number): Interval {
  if (leg === c.lengths.length - 1) {
    const side = c.end;
    return {
      id: c.endIds?.flange ?? c.endCapId ?? side.portId ?? 'open:end',
      start: length - side.length,
      end: length,
      gap: side.gap,
      kind: 'fitting',
      ...(side.join === undefined ? {} : { join: side.join }),
    };
  }
  return {
    id: `${c.env.run.id}/elbow-${leg + 1}`,
    start: length - (c.chosen.elbows[leg] as ElbowChoice).centreToEnd,
    end: length,
    gap: (c.chosen.joins[leg] as Join).gapMm,
    kind: 'fitting',
    join: c.chosen.joins[leg] as Join,
  };
}

function stackFailure(c: RunCtx, leg: number, stack: Exclude<ReturnType<typeof stackLeg>, Stack>): DerivationFailure {
  const external = (id: string): boolean => id === c.start.portId || id === c.end.portId || id.startsWith('open:');
  return fail(
    stack.code,
    `leg ${leg}: ${stack.message}`,
    [c.env.run.id, stack.detail.from, stack.detail.to].filter((id) => !external(id)),
    [`legs.${leg}`],
    { ...stack.detail, leg },
  );
}

const axisOf = (w: LegWalk): Vec3 => add3(w.origin, w.sideways);

function addPiece(
  c: RunCtx,
  w: LegWalk,
  a: Interval,
  b: Interval,
  piece: Piece,
  after: string,
  before: string,
): DerivationFailure | undefined {
  const runId = c.env.run.id;
  const info = c.env.pipeAt(w.dnHere);
  if (isFailure(info)) return info;
  const minimum = defaultMinWeldSpacing(info.wall);
  const [pipeStartEnd, pipeEndEnd] = [a.join?.pipeEnd ?? 'BW', b.join?.pipeEnd ?? 'BW'];
  if (piece.cut < minimum && (pipeStartEnd === 'BW' || pipeEndEnd === 'BW'))
    c.warnings.push(
      warningOf({ code: 'RTE_WELD_SPACING', from: a.id, to: b.id, cutLengthMm: piece.cut, minimumMm: minimum }, runId, w.leg),
    );
  const pieceId = c.mint('pipe');
  w.cuts.push(piece.cut);
  w.pieces.push({ id: pieceId, start: piece.start, end: piece.end });
  const { u } = w;
  c.parts.push(
    partOf(
      runId,
      pieceId,
      'pipe',
      info.row,
      [
        { position: at(axisOf(w), u, piece.start), direction: scale3(u, -1), dn: w.dnHere, endType: pipeStartEnd },
        { position: at(axisOf(w), u, piece.end), direction: u, dn: w.dnHere, endType: pipeEndEnd },
      ],
      { cutLength: piece.cut, leg: w.leg, dims: { outsideDiameter: info.od, wall: info.wall } },
    ),
  );
  if (!(c.start.weldless === true && w.leg === 0 && a.id === w.head.id))
    c.addJoint({ ...jointOf(a, w.weld), parts: [after, pieceId], position: at(axisOf(w), u, a.end) });
  c.addJoint({ ...jointOf(b, w.weld), parts: [pieceId, before], position: at(axisOf(w), u, b.start) });
  return undefined;
}

function addSlotParts(c: RunCtx, w: LegWalk, slot: Slot): void {
  const built = slot.build(axisOf(w), w.u);
  c.parts.push(...built.parts);
  built.joints.forEach(c.addJoint);
  if (built.inline !== undefined) c.inline.push(built.inline);
  if (slot.offset !== undefined) w.sideways = add3(w.sideways, slot.offset);
}

function walkStack(c: RunCtx, w: LegWalk, stack: Stack): DerivationFailure | undefined {
  for (let k = 0; k + 1 < stack.order.length; k++) {
    const [a, b] = [stack.order[k] as Interval, stack.order[k + 1] as Interval];
    w.dnHere = w.slotById.get(a.id)?.dnOut ?? w.dnHere;
    const [after, before] = [w.slotById.get(a.id)?.after ?? a.id, w.slotById.get(b.id)?.before ?? b.id];
    const piece = stack.pieces.find((candidate) => candidate.from === a.id && candidate.to === b.id);
    if (piece !== undefined) {
      const failure = addPiece(c, w, a, b, piece, after, before);
      if (failure !== undefined) return failure;
    } else c.addJoint({ kind: 'fittingToFitting', parts: [after, before], position: at(axisOf(w), w.u, a.end), gapMm: 0 });
    const slot = w.slotById.get(b.id);
    if (slot !== undefined) addSlotParts(c, w, slot);
  }
  return undefined;
}

function addOlets(c: RunCtx, leg: number, legPieces: readonly LegPiece[]): DerivationFailure | undefined {
  for (const fit of c.fits.filter((candidate) => candidate.point.leg === leg && BRANCH_KINDS.has(candidate.kind))) {
    const x = fit.point.distance;
    const margin = fit.branchOd / 2;
    const host = legPieces.find((piece) => piece.start + margin <= x && x <= piece.end - margin);
    if (host === undefined)
      return fail(
        'RTE_BRANCH_ON_FITTING',
        `branch ${fit.point.id} at ${+x.toFixed(4)} mm on leg ${leg} does not lie on a pipe piece with ${+margin.toFixed(2)} mm to each end (${fit.typeKey} needs a straight piece)`,
        [c.env.run.id, fit.point.id],
        ['branches'],
        { leg, distance: x, marginMm: margin },
      );
    const olet = oletPart(c.env, fit, host.id);
    c.parts.push(olet.part);
    c.addJoint(olet.joint);
  }
  return undefined;
}

function addElbow(c: RunCtx, leg: number): DerivationFailure | undefined {
  const run = c.env.run;
  const index = leg + 1;
  const u = c.dirs[leg] as Vec3;
  const choice = c.chosen.elbows[leg] as ElbowChoice;
  const turn = c.chosen.turns[leg] as DerivedTurn;
  const next = c.dirs[index] as Vec3;
  const pi = add3(c.points[index] as Vec3, c.shifts.offset[leg] as Vec3);
  const centreToEnd = choice.centreToEnd;
  const dn = dnAfter(run, c.env.line.dn, leg, Number.POSITIVE_INFINITY);
  const info = c.env.pipeAt(dn);
  if (isFailure(info)) return info;
  const endType = (c.chosen.joins[leg] as Join).end;
  c.parts.push(
    partOf(
      run.id,
      turn.partId,
      'elbow',
      choice.row,
      [
        { position: at(pi, u, -centreToEnd), direction: scale3(u, -1), dn, endType },
        { position: at(pi, next, centreToEnd), direction: next, dn, endType },
      ],
      { centre: pi, angleDeg: choice.turnDeg, radius: choice.radius, ...turnPartFields(choice, info.od) },
    ),
  );
  return undefined;
}

/** Stacks leg `leg` (pipe pieces, fittings, inline slots), adds its parts, joints, branch olets, record and the elbow that follows. */
export function deriveLeg(c: RunCtx, leg: number): DerivationFailure | undefined {
  const run = c.env.run;
  const u = c.dirs[leg] as Vec3;
  const origin = c.points[leg] as Vec3;
  const length = c.lengths[leg] as number;
  const shift = c.shifts.start[leg] as number;
  const mids = c.slotsByLeg.get(leg) ?? [];
  const head = headInterval(c, leg, shift);
  const tail = tailInterval(c, leg, length);
  const stack = stackLeg(length, [head, ...mids.map((slot) => slot.interval), tail], 0, c.eps);
  if (!stack.ok) return stackFailure(c, leg, stack);
  const w: LegWalk = {
    leg,
    u,
    origin,
    head,
    slotById: new Map(mids.map((slot) => [slot.interval.id, slot])),
    weld: c.env.weld?.joint ?? 'buttWeld',
    cuts: [],
    pieces: [],
    sideways: [0, 0, 0],
    dnHere: dnAfter(run, c.env.line.dn, leg - 1, Number.POSITIVE_INFINITY),
  };
  const walked = walkStack(c, w, stack);
  if (walked !== undefined) return walked;
  for (const warning of stack.warnings) c.warnings.push(warningOf(warning, run.id, leg));
  const olets = addOlets(c, leg, w.pieces);
  if (olets !== undefined) return olets;
  c.legs.push({
    index: leg,
    direction: directionLabel(u),
    lengthMm: length - shift,
    start: at(origin, u, shift),
    end: add3(c.points[leg + 1] as Vec3, c.shifts.offset[leg] as Vec3),
    cutLengthsMm: w.cuts,
    ...(isSloped(u) ? slopeFields(u, length - shift) : {}),
  });
  return leg < c.lengths.length - 1 ? addElbow(c, leg) : undefined;
}
