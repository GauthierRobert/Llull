/**
 * Branches downstream of an eccentric reducer (02 RTE V1, design decision: the branch axis lies on the shifted leg). The header axis downstream of an
 * eccentric reducer of a leg is the stored axis plus the offsets of the reducers before the branch point; the tee centre / olet position and the
 * outlet face follow it. A branch run still starts at the stored point of its first leg, so its first pipe starts `shift . direction` further along
 * the branch. The part of the offset sideways of the branch (a horizontal branch off a flat-on-top reducer) moves the DERIVED first point of the branch
 * run by that sideways part (`shiftedBranchRun`): the stored polyline stays the user's request, the derived axis starts at the shifted outlet.
 */

import type { Vec3 } from '@core/model/vectors';
import type { BranchPoint } from '@aec/plant/types';
import { add3, dot3, len3, scale3, sub3 } from '@lib/vec3';
import { fail, isFailure, type DerivationFailure } from './deriveTypes';
import { eccentricOffset, flatPerpendicular } from './eccentric';
import { unitVector } from './legs';
import { getPiping, runPoints } from './model';
import type { PipeRun } from '@aec/plant/types';
import type { Env } from './routeEnv';
import { inlineInOrder, isReducer, startDn } from './runSizes';

interface Shiftable {
  readonly point: BranchPoint;
  readonly direction: Vec3;
  readonly shift: Vec3;
  readonly residualMm?: number;
  readonly sideways?: Vec3;
}

interface Offset {
  readonly leg: number;
  readonly at: number;
  readonly offset: Vec3;
}

/** The offset of every eccentric reducer of the run; one that cannot be resolved is skipped (the run's own derivation reports it). */
function reducerOffsets(env: Env): Offset[] {
  const points = runPoints(env.run);
  const out: Offset[] = [];
  let dn = startDn(env.run, env.line.dn);
  for (const comp of inlineInOrder(env.run)) {
    const dnOut = isReducer(comp) && comp.dn2 !== undefined ? comp.dn2 : dn;
    const [from, to] = [points[comp.leg], points[comp.leg + 1]];
    if (comp.type === 'reducerEccentric' && comp.flatDirection !== undefined && from !== undefined && to !== undefined) {
      const flat = flatPerpendicular(comp.flatDirection, unitVector(sub3(to, from)));
      const [pipeIn, pipeOut] = [env.pipeAt(dn), env.pipeAt(dnOut)];
      if (flat !== null && !isFailure(pipeIn) && !isFailure(pipeOut))
        out.push({ leg: comp.leg, at: comp.centreDistance, offset: eccentricOffset(flat, pipeIn.od, pipeOut.od) });
    }
    dn = dnOut;
  }
  return out;
}

/**
 * `fits` with `shift` = the sum of the offsets of the eccentric reducers upstream of each branch point on its leg.
 * @invariant an offset within the branch tolerance of the branch direction (a vertical branch on a gently sloped leg) is taken up along the branch; the sideways residual is reported (`residualMm`)
 * @invariant an offset sideways of the branch beyond the tolerance is kept whole in `shift`; its part perpendicular to the branch is `sideways` (the branch run's derived start moves by it)
 */
export function withBranchShifts<T extends Shiftable>(env: Env, fits: readonly T[]): T[] | DerivationFailure {
  const reducers = reducerOffsets(env);
  const shifted: T[] = [];
  for (const fit of fits) {
    const shift = reducers
      .filter((reducer) => reducer.leg === fit.point.leg && reducer.at < fit.point.distance)
      .reduce((sum, reducer) => add3(sum, reducer.offset), [0, 0, 0] as Vec3);
    const size = len3(shift);
    const across = len3(sub3(shift, scale3(fit.direction, dot3(shift, fit.direction))));
    const sideways = size > 0 && across > Math.max(1e-3, 1e-6 * size);
    const angleDeg = size > 0 ? (Math.acos(Math.min(1, Math.abs(dot3(shift, fit.direction)) / size)) * 180) / Math.PI : 0;
    const tolerance = getPiping(env.doc).runs[fit.point.branchRunId]?.angleToleranceDeg ?? env.tolerance.valueDeg;
    const moved = sideways && angleDeg > tolerance;
    shifted.push(
      size === 0
        ? fit
        : {
            ...fit,
            shift,
            ...(moved
              ? { sideways: sub3(shift, scale3(fit.direction, dot3(shift, fit.direction))) }
              : sideways
                ? { residualMm: across }
                : {}),
          },
    );
  }
  return shifted;
}

/**
 * The run whose axis a branch run derives on: its stored first point moved by `sideways` (the part of the header offset perpendicular to the branch, from
 * `branchStartSetup`). One leg: the whole pipe moves with it (the end must be an open end); more legs: the first leg translates and the corner after it moves
 * with it, which only works when `sideways` runs along the second leg (it then starts that much further along its own axis).
 * @failure the end is connected to a port (it cannot follow), the offset is not along the second leg, or the run carries branches of its own (they sit on the stored axis) -> RTE_BRANCH_ON_FITTING naming the branch run
 */
export function shiftedBranchRun(env: Env, sideways: Vec3 | undefined): PipeRun | DerivationFailure {
  const run = env.run;
  if (sideways === undefined) return run;
  const size = len3(sideways);
  const id = run.start.ref?.kind === 'branch' ? run.start.ref.branchId : run.id;
  const refuse = (why: string): DerivationFailure =>
    fail(
      'RTE_BRANCH_ON_FITTING',
      `branch run ${run.id} (${id}) leaves the shifted axis of an eccentric reducer upstream, ${+size.toFixed(3)} mm sideways of its stored start: ${why}`,
      [run.id, id],
      ['start'],
      { sideways },
    );
  if ((run.branches ?? []).length > 0)
    return refuse('it carries branches of its own, which would sit on the stored axis; take them off a run that starts on the stored axis');
  const points = runPoints(run);
  const next = points[2] === undefined ? undefined : unitVector(sub3(points[2], points[1] as Vec3));
  if (next === undefined && run.end.ref !== undefined)
    return refuse(
      `its end is connected to ${run.end.ref.kind === 'branch' ? 'a branch' : 'a port'} and cannot follow; route a second leg along the offset or leave the end open`,
    );
  if (next !== undefined) {
    const across = len3(sub3(sideways, scale3(next, dot3(sideways, next))));
    if (across > Math.max(1e-3, 1e-6 * size))
      return refuse(
        `the second leg [${next.map((v) => +v.toFixed(4)).join(', ')}] is not along the offset: the corner cannot follow it. Turn the flat side along the branch or the second leg`,
      );
  }
  const moveEnd = next === undefined;
  return {
    ...run,
    start: { ...run.start, point: add3(run.start.point, sideways) },
    pis: run.pis.map((point, i) => (i === 0 ? add3(point, sideways) : point)),
    end: moveEnd ? { ...run.end, point: add3(run.end.point, sideways) } : run.end,
  };
}
