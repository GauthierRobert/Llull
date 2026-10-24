/**
 * Orthogonal stretch of a run when a port it is connected to moves (02 RTE §5.7, M3): the stored end points are where the run was routed, so the
 * displacement of an end is the distance from that point to the port now. The walk (`stretchWalk`) finds how the points of intersection move so every leg
 * keeps its direction; inline components and branches keep their position along the leg axis. The stretched run must still derive, else the stretch fails
 * and the run is left as routed (and marked broken by the caller).
 * @invariant legs keep their direction (and slope); a stretched run is only returned when it derives; nothing is stored here
 */

import type { CadDocument } from '@core/model/types';
import type { Vec3 } from '@core/model/vectors';
import type { PipeRun } from '@aec/plant/types';
import { add3, dot3, len3, sub3 } from '@lib/vec3';
import { angleBetweenDeg, directionLabel, epsilonFor, unitVector } from './legs';
import { getPiping, runPoints, withPiping } from './model';
import { portOfRef } from './ports';
import { deriveRun } from './routeParts';
import { walkChain, type Disp } from './stretchWalk';

export interface LegChange {
  readonly leg: number;
  readonly direction: string;
  readonly changeMm: number;
}

export interface StretchDone {
  readonly kind: 'stretched';
  readonly run: PipeRun;
  /** `doc` with the stretched run stored (it derives in this document). */
  readonly document: CadDocument;
  readonly startMoveMm: Vec3 | null;
  readonly endMoveMm: Vec3 | null;
  readonly legChanges: readonly LegChange[];
}

export type StretchOutcome =
  | { readonly kind: 'none' }
  | StretchDone
  | { readonly kind: 'failed'; readonly reason: string; readonly detail: Readonly<Record<string, unknown>> };

const fmt = (v: Vec3): string => v.map((x) => +x.toFixed(3)).join(', ');

/** A run with its points displaced; failures name the leg or component that cannot take it. */
export function displaceRun(
  run: PipeRun,
  displacements: readonly Disp[],
  exactStart?: Vec3,
  exactEnd?: Vec3,
): { readonly ok: true; readonly run: PipeRun; readonly legChanges: LegChange[] } | { readonly ok: false; readonly reason: string } {
  const points = runPoints(run);
  const eps = epsilonFor(...points);
  const moved = points.map((p, i) => add3(p, displacements[i] as Disp));
  if (exactStart !== undefined) moved[0] = exactStart;
  if (exactEnd !== undefined) moved[moved.length - 1] = exactEnd;
  const legChanges: LegChange[] = [];
  const axial: number[] = [];
  const lengths: number[] = [];
  for (let leg = 0; leg + 1 < points.length; leg++) {
    const old = sub3(points[leg + 1] as Vec3, points[leg] as Vec3);
    const u = unitVector(old);
    const next = sub3(moved[leg + 1] as Vec3, moved[leg] as Vec3);
    const length = dot3(next, u);
    if (!(length > eps) || len3(sub3(next, [u[0] * length, u[1] * length, u[2] * length])) > Math.max(eps, 1e-6 * length))
      return {
        ok: false,
        reason: `leg ${leg} (${String(directionLabel(u))}, ${+len3(old).toFixed(3)} mm) would become ${+length.toFixed(3)} mm or leave its direction`,
      };
    lengths.push(length);
    axial.push(dot3(displacements[leg] as Disp, u));
    const change = length - len3(old);
    if (Math.abs(change) > eps) legChanges.push({ leg, direction: String(directionLabel(u)), changeMm: change });
  }
  const along = (leg: number, distance: number, what: string): number | string => {
    const next = distance - (axial[leg] as number);
    return next > eps && next < (lengths[leg] as number) - eps
      ? next
      : `${what} would leave leg ${leg} (${+next.toFixed(3)} mm of ${+(lengths[leg] as number).toFixed(3)} mm)`;
  };
  const inline: NonNullable<PipeRun['inline']>[number][] = [];
  for (const item of run.inline ?? []) {
    const distance = along(item.leg, item.centreDistance, `${item.type} ${item.id}`);
    if (typeof distance === 'string') return { ok: false, reason: distance };
    inline.push({ ...item, centreDistance: distance });
  }
  const branches: NonNullable<PipeRun['branches']>[number][] = [];
  for (const branch of run.branches ?? []) {
    const distance = along(branch.leg, branch.distance, `branch ${branch.id}`);
    if (typeof distance === 'string') return { ok: false, reason: distance };
    branches.push({ ...branch, distance });
  }
  const next: PipeRun = {
    ...run,
    start: { ...run.start, point: moved[0] as Vec3 },
    end: { ...run.end, point: moved[moved.length - 1] as Vec3 },
    pis: moved.slice(1, -1),
    ...(run.inline === undefined ? {} : { inline }),
    ...(run.branches === undefined ? {} : { branches }),
  };
  return { ok: true, run: next, legChanges };
}

/** `doc` with `run` stored in place of the run of the same id. */
export function withRunStored(doc: CadDocument, run: PipeRun): CadDocument {
  const piping = getPiping(doc);
  return withPiping(doc, { ...piping, runs: { ...piping.runs, [run.id]: run } });
}

interface EndMove {
  readonly pinned: boolean;
  readonly move: Disp;
  readonly position: Vec3 | null;
}

/**
 * The stretch `run` needs now: its connected ends are compared with their ports (a nozzle that moved with its equipment, a tie-in, the point of a
 * header it branches from) and the displacement is walked back through the legs.
 * @failure a port turned away, an end no leg can follow (the remainder reaches the other port), a leg that would vanish, a component that would leave
 *   its leg, or a stretched run that no longer derives -> `failed` with the reason; the run is untouched
 */
export function stretchRun(doc: CadDocument, run: PipeRun): StretchOutcome {
  const points = runPoints(run);
  const eps = epsilonFor(...points);
  const ends: Record<'start' | 'end', EndMove> = {
    start: { pinned: false, move: [0, 0, 0], position: null },
    end: { pinned: false, move: [0, 0, 0], position: null },
  };
  for (const side of ['start', 'end'] as const) {
    const ref = run[side].ref;
    if (ref === undefined) continue;
    const port = portOfRef(doc, ref);
    if (port === null) return { kind: 'none' };
    const turned = run[side].direction;
    if (turned !== undefined && angleBetweenDeg(unitVector(turned), unitVector(port.direction)) > 1e-4)
      return {
        kind: 'failed',
        reason: `the ${side} port now faces ${fmt(port.direction)} but the run ${side} was routed along ${fmt(turned)} (the equipment was turned)`,
        detail: { side, portDirection: port.direction, routedDirection: turned },
      };
    const move = sub3(port.position, run[side].point);
    ends[side] = { pinned: true, move: len3(move) <= eps ? [0, 0, 0] : move, position: port.position };
  }
  if (len3(ends.start.move) === 0 && len3(ends.end.move) === 0) return { kind: 'none' };
  const dirs = points.slice(1).map((p, i) => unitVector(sub3(p, points[i] as Vec3)));
  const walked = walkChain(dirs, ends.start.pinned ? ends.start.move : null, ends.end.pinned ? ends.end.move : null, eps);
  if (!walked.ok)
    return {
      kind: 'failed',
      reason:
        `an orthogonal stretch cannot follow the move (start ${fmt(ends.start.move)}, end ${fmt(ends.end.move)} mm): ` +
        `a remainder of ${fmt(walked.remainder)} mm reaches the ${walked.at === 'first' ? 'start' : 'end'} port and no leg is parallel to it`,
      detail: { startMove: ends.start.move, endMove: ends.end.move, remainder: walked.remainder },
    };
  const displaced = displaceRun(run, walked.displacements, ends.start.position ?? undefined, ends.end.position ?? undefined);
  if (!displaced.ok)
    return {
      kind: 'failed',
      reason: `the stretch is not possible: ${displaced.reason}`,
      detail: { startMove: ends.start.move, endMove: ends.end.move },
    };
  const document = withRunStored(doc, displaced.run);
  const derived = deriveRun(document, displaced.run);
  if (!derived.ok)
    return {
      kind: 'failed',
      reason: `the stretched run no longer derives: ${derived.code}: ${derived.message}`,
      detail: { derivationCode: derived.code, startMove: ends.start.move, endMove: ends.end.move },
    };
  return {
    kind: 'stretched',
    run: displaced.run,
    document,
    startMoveMm: ends.start.pinned && len3(ends.start.move) > 0 ? ends.start.move : null,
    endMoveMm: ends.end.pinned && len3(ends.end.move) > 0 ? ends.end.move : null,
    legChanges: displaced.legChanges,
  };
}
