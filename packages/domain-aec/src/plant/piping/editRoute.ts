/**
 * Route edits (02 RTE §4 `edit_route`, M3): move a point of intersection, stretch a leg, insert or delete points of intersection. The geometry of one
 * stored run changes; the merged-leg indices and distances of its inline components and branches and its declared leg slopes are remapped with it
 * (a component keeps the distance from the end of its leg that did not move). Pure: the caller derives the result and decides.
 * @invariant an orthogonal move keeps every leg direction (the stretch walk); free moves, insertions and deletions merge points that became collinear
 */

import type { Vec3 } from '@core/model/vectors';
import type { PipeRun, Slope } from '@aec/plant/types';
import { add3, cross3, dot3, len3, sub3 } from '@lib/vec3';
import { directionLabel, epsilonFor, unitVector } from './legs';
import { runPoints } from './model';
import { displaceRun, type LegChange } from './stretch';
import { walkWithInjection } from './stretchWalk';

export type RouteEdit =
  | { readonly op: 'move_pi'; readonly index: number; readonly by: Vec3; readonly mode: 'orthogonal' | 'free' }
  | { readonly op: 'stretch_leg'; readonly index: number; readonly length: number }
  | { readonly op: 'insert_pi'; readonly index: number; readonly points: readonly Vec3[] }
  | { readonly op: 'delete_pi'; readonly index: number; readonly count: number };

export interface EditFailure {
  readonly ok: false;
  readonly code: 'RTE_EDIT_INVALID' | 'RTE_STRETCH_FAILED' | 'RTE_ZERO_LEG';
  readonly message: string;
  readonly paths: readonly string[];
  readonly detail: Readonly<Record<string, unknown>>;
}

export interface EditOk {
  readonly ok: true;
  readonly run: PipeRun;
  /** Legs whose length changed (merged-leg indices of the new run). */
  readonly legChanges: readonly LegChange[];
  /** Components and branches that now sit on another leg or at another distance: `<id> leg a @ x -> leg b @ y`. */
  readonly remapped: readonly string[];
  /** Number of legs before the edit and the lengths of the legs after it (mm); the leg count changes when legs merge or split. */
  readonly legsBefore: number;
  readonly legLengths: readonly number[];
}

/**
 * What the connected ends of the run are held to: `startMove` / `endMove` = how far the port is from where the run was routed (zero when in step, null
 * for an open end, which follows freely); `startPort` / `endPort` = the port positions the ends are set to by the free edits.
 */
export interface EditContext {
  readonly startMove: Vec3 | null;
  readonly endMove: Vec3 | null;
  readonly startPort: Vec3 | null;
  readonly endPort: Vec3 | null;
}

const fail = (code: EditFailure['code'], message: string, paths: readonly string[], detail: Record<string, unknown> = {}): EditFailure => ({
  ok: false,
  code,
  message,
  paths,
  detail,
});

const mm = (v: readonly number[]): string => v.map((x) => +x.toFixed(3)).join(', ');

type Place = (leg: number, distance: number) => { leg: number; distance: number } | string;
interface Shape {
  readonly points: Vec3[];
  readonly slopes: Array<Slope | null>;
  readonly place: Place;
}

/** Points that became collinear with their neighbours are dropped and the legs merge (the merged leg keeps the first declared slope). */
function mergeStraight(shape: Shape): Shape {
  let { points, slopes, place } = shape;
  for (let i = 1; i < points.length - 1; ) {
    const before = unitVector(sub3(points[i] as Vec3, points[i - 1] as Vec3));
    const after = unitVector(sub3(points[i + 1] as Vec3, points[i] as Vec3));
    if (!(len3(cross3(before, after)) < 1e-9 && dot3(before, after) > 0)) {
      i += 1;
      continue;
    }
    const a = i - 1;
    const lengthA = len3(sub3(points[i] as Vec3, points[a] as Vec3));
    const previous = place;
    place = (leg, distance) => {
      const at = previous(leg, distance);
      if (typeof at === 'string') return at;
      if (at.leg === a + 1) return { leg: a, distance: at.distance + lengthA };
      return at.leg > a + 1 ? { leg: at.leg - 1, distance: at.distance } : at;
    };
    slopes = [...slopes.slice(0, a), slopes[a] ?? slopes[a + 1] ?? null, ...slopes.slice(a + 2)];
    points = [...points.slice(0, i), ...points.slice(i + 1)];
  }
  return { points, slopes, place };
}

/** The run rebuilt on `shape`: ends and points set, components and branches placed, slopes stored; failures name what does not fit. */
function rebuild(run: PipeRun, shape: Shape): EditOk | EditFailure {
  const { points, slopes, place } = shape;
  const eps = epsilonFor(...runPoints(run), ...points);
  const lengths = points.slice(1).map((p, i) => len3(sub3(p, points[i] as Vec3)));
  const zero = lengths.findIndex((length) => !(length > eps));
  if (zero >= 0) return fail('RTE_ZERO_LEG', `the edit leaves leg ${zero} with zero length`, [`legs.${zero}`], { leg: zero });
  const remapped: string[] = [];
  const placed = (id: string, leg: number, distance: number, what: string): { leg: number; distance: number } | EditFailure => {
    const at = place(leg, distance);
    if (typeof at === 'string') return fail('RTE_EDIT_INVALID', `${what} ${id}: ${at}`, ['index'], { id });
    const length = lengths[at.leg];
    if (length === undefined || !(at.distance > eps && at.distance < length - eps))
      return fail('RTE_EDIT_INVALID', `${what} ${id} would leave the route (leg ${at.leg}, ${+at.distance.toFixed(3)} mm)`, ['index'], {
        id,
      });
    if (at.leg !== leg || Math.abs(at.distance - distance) > eps)
      remapped.push(`${id} leg ${leg} @ ${+distance.toFixed(3)} -> leg ${at.leg} @ ${+at.distance.toFixed(3)}`);
    return at;
  };
  const inline: NonNullable<PipeRun['inline']>[number][] = [];
  for (const item of run.inline ?? []) {
    const at = placed(item.id, item.leg, item.centreDistance, item.type);
    if ('ok' in at) return at;
    inline.push({ ...item, leg: at.leg, centreDistance: at.distance });
  }
  const branches: NonNullable<PipeRun['branches']>[number][] = [];
  for (const branch of run.branches ?? []) {
    const at = placed(branch.id, branch.leg, branch.distance, 'branch');
    if ('ok' in at) return at;
    branches.push({ ...branch, leg: at.leg, distance: at.distance });
  }
  const { legSlopes: previousSlopes, ...rest } = run;
  void previousSlopes;
  const next: PipeRun = {
    ...rest,
    start: { ...run.start, point: points[0] as Vec3 },
    end: { ...run.end, point: points[points.length - 1] as Vec3 },
    pis: points.slice(1, -1),
    ...(run.inline === undefined ? {} : { inline }),
    ...(run.branches === undefined ? {} : { branches }),
    ...(slopes.some((slope) => slope !== null) ? { legSlopes: slopes } : {}),
  };
  // Leg indices only line up when the number of legs is unchanged (a move or a stretch); an insertion or deletion reports the new legs in the derivation.
  const old = runPoints(run);
  const legChanges: LegChange[] =
    old.length !== points.length
      ? []
      : lengths.flatMap((length, leg) => {
          const was = len3(sub3(old[leg + 1] as Vec3, old[leg] as Vec3));
          const direction = String(directionLabel(unitVector(sub3(points[leg + 1] as Vec3, points[leg] as Vec3))));
          return Math.abs(length - was) > eps ? [{ leg, direction, changeMm: length - was }] : [];
        });
  return { ok: true, run: next, legChanges, remapped, legsBefore: old.length - 1, legLengths: lengths };
}

const legSlopesOf = (run: PipeRun): Array<Slope | null> => Array.from({ length: run.pis.length + 1 }, (_, i) => run.legSlopes?.[i] ?? null);

function orthogonal(run: PipeRun, k: number, by: Vec3, ctx: EditContext): EditOk | EditFailure {
  const points = runPoints(run);
  const eps = epsilonFor(...points);
  const dirs = points.slice(1).map((p, i) => unitVector(sub3(p, points[i] as Vec3)));
  if ((k === 0 && ctx.startMove !== null) || (k === points.length - 1 && ctx.endMove !== null))
    return fail(
      'RTE_STRETCH_FAILED',
      `the ${k === 0 ? 'start' : 'end'} of run ${run.id} is connected to a port: move the equipment, or edit an interior point`,
      ['index'],
      { index: k },
    );
  const walked = walkWithInjection(dirs, k, by, ctx.startMove, ctx.endMove, eps);
  if (!walked.ok)
    return fail(
      'RTE_STRETCH_FAILED',
      `no leg ${walked.side === 'before' ? 'before' : 'after'} the moved point is parallel to the remainder ${mm(walked.remainder)} mm that would reach the ${walked.side === 'before' ? 'start' : 'end'} port: the move cannot be absorbed orthogonally (use mode "free" for a non-orthogonal edit)`,
      ['delta'],
      { remainder: walked.remainder, side: walked.side },
    );
  const displaced = displaceRun(run, walked.displacements, ctx.startPort ?? undefined, ctx.endPort ?? undefined);
  if (!displaced.ok) return fail('RTE_STRETCH_FAILED', displaced.reason, ['delta']);
  return {
    ok: true,
    run: displaced.run,
    legChanges: displaced.legChanges,
    remapped: [],
    legsBefore: run.pis.length + 1,
    legLengths: runPoints(displaced.run)
      .slice(1)
      .map((p, i) => len3(sub3(p, runPoints(displaced.run)[i] as Vec3))),
  };
}

/** The points of `run` with its connected ends set to their ports. */
const syncedPoints = (run: PipeRun, ctx: EditContext): Vec3[] =>
  runPoints(run).map((p, i, all) => (i === 0 ? (ctx.startPort ?? p) : i === all.length - 1 ? (ctx.endPort ?? p) : p));

function freeMove(run: PipeRun, k: number, by: Vec3, ctx: EditContext): EditOk | EditFailure {
  const points = syncedPoints(run, ctx);
  const moved = points.map((p, i) => (i === k ? add3(p, by) : p));
  const lengthOf = (list: readonly Vec3[], leg: number): number => len3(sub3(list[leg + 1] as Vec3, list[leg] as Vec3));
  const place: Place = (leg, distance) => {
    if (leg === k) return { leg, distance: distance + (lengthOf(moved, leg) - lengthOf(points, leg)) };
    return { leg, distance };
  };
  // The declared slopes stay: a leg the edit tilts against its declaration is reported by check_piping (RTE_ADVERSE_SLOPE).
  return rebuild(run, mergeStraight({ points: moved, slopes: legSlopesOf(run), place }));
}

function insertPoints(run: PipeRun, leg: number, added: readonly Vec3[], ctx: EditContext): EditOk | EditFailure {
  const points = syncedPoints(run, ctx);
  const next = [...points.slice(0, leg + 1), ...added, ...points.slice(leg + 1)];
  const m = added.length;
  const lengthOf = (list: readonly Vec3[], index: number): number => len3(sub3(list[index + 1] as Vec3, list[index] as Vec3));
  const [first, last, old] = [lengthOf(next, leg), lengthOf(next, leg + m), lengthOf(points, leg)];
  const eps = epsilonFor(...points, ...added);
  const place: Place = (at, distance) => {
    if (at < leg) return { leg: at, distance };
    if (at > leg) return { leg: at + m, distance };
    if (distance < first - eps) return { leg, distance };
    const fromEnd = last - (old - distance);
    return fromEnd > eps
      ? { leg: leg + m, distance: fromEnd }
      : `at ${+distance.toFixed(3)} mm of leg ${leg}, fits neither the first new leg (${+first.toFixed(3)} mm) nor the last (${+last.toFixed(3)} mm)`;
  };
  const slopes = legSlopesOf(run);
  const spliced = [...slopes.slice(0, leg), ...Array.from({ length: m + 1 }, () => null), ...slopes.slice(leg + 1)];
  return rebuild(run, mergeStraight({ points: next, slopes: spliced, place }));
}

function deletePoints(run: PipeRun, j: number, count: number, ctx: EditContext): EditOk | EditFailure {
  const points = syncedPoints(run, ctx);
  const next = [...points.slice(0, j + 1), ...points.slice(j + 1 + count)];
  const lengthOf = (list: readonly Vec3[], index: number): number => len3(sub3(list[index + 1] as Vec3, list[index] as Vec3));
  const merged = lengthOf(next, j);
  const place: Place = (at, distance) => {
    if (at < j) return { leg: at, distance };
    if (at === j) return { leg: j, distance };
    if (at > j + count) return { leg: at - count, distance };
    if (at === j + count) return { leg: j, distance: merged - (lengthOf(points, at) - distance) };
    return `on leg ${at}, which the deletion removes: move it onto leg ${j} or ${j + count} first`;
  };
  const slopes = legSlopesOf(run);
  const spliced = [...slopes.slice(0, j), null, ...slopes.slice(j + count + 1)];
  return rebuild(run, mergeStraight({ points: next, slopes: spliced, place }));
}

/**
 * Applies `edit` to the stored geometry of `run` (not yet derived).
 * @failure index out of range, zero delta / length, a move no leg can absorb, a leg that vanishes or a component that no longer fits -> the failure
 */
export function editRun(run: PipeRun, edit: RouteEdit, ctx: EditContext): EditOk | EditFailure {
  const pis = run.pis.length;
  const legs = pis + 1;
  switch (edit.op) {
    case 'move_pi': {
      if (!(edit.index >= 0 && edit.index < pis))
        return fail(
          'RTE_EDIT_INVALID',
          `run ${run.id} has ${pis} interior point(s) of intersection (index 0..${pis - 1}), not ${edit.index}`,
          ['index'],
          { pis },
        );
      if (!(len3(edit.by) > epsilonFor(...runPoints(run))))
        return fail('RTE_EDIT_INVALID', 'the point is already there: delta / point gives no move', ['delta']);
      return edit.mode === 'free' ? freeMove(run, edit.index + 1, edit.by, ctx) : orthogonal(run, edit.index + 1, edit.by, ctx);
    }
    case 'stretch_leg': {
      if (!(edit.index >= 0 && edit.index < legs))
        return fail('RTE_EDIT_INVALID', `run ${run.id} has ${legs} leg(s) (index 0..${legs - 1}), not ${edit.index}`, ['index'], { legs });
      const points = runPoints(run);
      const u = unitVector(sub3(points[edit.index + 1] as Vec3, points[edit.index] as Vec3));
      const by = edit.length - len3(sub3(points[edit.index + 1] as Vec3, points[edit.index] as Vec3));
      if (Math.abs(by) <= epsilonFor(...points)) return fail('RTE_EDIT_INVALID', `leg ${edit.index} already has this length`, ['length']);
      return orthogonal(run, edit.index + 1, [u[0] * by, u[1] * by, u[2] * by], ctx);
    }
    case 'insert_pi': {
      if (!(edit.index >= 0 && edit.index < legs))
        return fail('RTE_EDIT_INVALID', `run ${run.id} has ${legs} leg(s) (index 0..${legs - 1}), not ${edit.index}`, ['index'], { legs });
      return insertPoints(run, edit.index, edit.points, ctx);
    }
    case 'delete_pi': {
      if (!(edit.index >= 0 && edit.count >= 1 && edit.index + edit.count <= pis))
        return fail(
          'RTE_EDIT_INVALID',
          `run ${run.id} has ${pis} interior point(s) of intersection: cannot delete ${edit.count} from index ${edit.index}`,
          ['index'],
          { pis },
        );
      return deletePoints(run, edit.index, edit.count, ctx);
    }
  }
}
