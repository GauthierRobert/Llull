/**
 * Branches downstream of an eccentric reducer (02 RTE V1, design decision: the branch axis lies on the shifted leg). The header axis downstream of an
 * eccentric reducer of a leg is the stored axis plus the offsets of the reducers before the branch point; the tee centre / olet position and the
 * outlet face follow it. A branch run still starts at the stored point of its first leg, so its first pipe starts `shift . direction` further along
 * the branch; an offset that is not along the branch direction cannot be taken up and is refused.
 */

import type { Vec3 } from '@core/model/vectors';
import type { BranchPoint } from '@aec/plant/types';
import { add3, dot3, len3, scale3, sub3 } from '@lib/vec3';
import { fail, isFailure, type DerivationFailure } from './deriveTypes';
import { eccentricOffset, flatPerpendicular } from './eccentric';
import { unitVector } from './legs';
import { runPoints } from './model';
import type { Env } from './routeEnv';
import { inlineInOrder, isReducer, startDn } from './runSizes';

interface Shiftable {
  readonly point: BranchPoint;
  readonly direction: Vec3;
  readonly shift: Vec3;
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
 * @failure a shifted branch whose direction is not along the offset -> RTE_BRANCH_ON_FITTING naming the branch
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
    if (size > 0 && across > Math.max(1e-3, 1e-6 * size))
      return fail(
        'RTE_BRANCH_ON_FITTING',
        `branch ${fit.point.id} sits downstream of an eccentric reducer on leg ${fit.point.leg} of run ${env.run.id}; the axis there is ${+size.toFixed(3)} mm off the stored line toward [${shift.map((v) => +(v / size).toFixed(4)).join(', ')}], which is not along the branch direction [${fit.direction.map((v) => +v.toFixed(4)).join(', ')}]: the branch run would have to move sideways with it. Turn the flat side along the branch, or take the branch off before the reducer`,
        [env.run.id, fit.point.id],
        ['branches'],
        { leg: fit.point.leg, distance: fit.point.distance, shift },
      );
    shifted.push(size > 0 ? { ...fit, shift } : fit);
  }
  return shifted;
}
