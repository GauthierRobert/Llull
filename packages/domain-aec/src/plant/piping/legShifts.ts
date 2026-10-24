/**
 * How eccentric reducers move the pipe downstream of them (02 RTE V1). A reducer in leg i shifts the axis by its offset D (perpendicular to the leg); the
 * sum D_i over the leg moves the next point of intersection by D_i, which only works when D_i is parallel to leg i + 1 (within the angle tolerance of the
 * run, as an elbow angle is: the sideways residual is reported): that leg then starts D_i . u further along its own axis (so it is that much shorter or
 * longer) and nothing else moves. The last leg has no leg to give way, so its offsets must cancel (a reducer and an expander).
 * @invariant stored points of intersection stay the geometry of the run: only the corner after a leg with offsets, and the pipe after a reducer inside its
 *   leg, sit off the stored line
 */

import type { Vec3 } from '@core/model/vectors';
import { add3, dot3, len3, scale3, sub3 } from '@lib/vec3';
import { fail, type DerivationFailure, type DerivationWarning } from './deriveTypes';
import type { BranchFit } from './routeBranch';
import type { Env, Slot } from './routeEnv';

export interface LegShifts {
  /** Per leg: the sum of the offsets of its eccentric reducers (zero vector when none). */
  readonly offset: readonly Vec3[];
  /** Per leg: how far along the leg axis its start moved (the previous leg's offset . this leg's direction), mm. */
  readonly start: readonly number[];
  /** A warning per leg whose offset the next leg takes up only within the angle tolerance (the sideways residual is dropped). */
  readonly warnings: readonly DerivationWarning[];
}

const ZERO: Vec3 = [0, 0, 0];

/**
 * The offsets of the legs of the run in `env` and the axial start shift they cause.
 * @failure an offset the next leg cannot absorb (not parallel to it), or left on the last leg -> RTE_ECCENTRIC_OFFSET naming the reducers;
 *   a branch downstream of an eccentric reducer on the same leg -> RTE_BRANCH_ON_FITTING (the branch point is a port on the stored axis)
 */
export function legShifts(
  env: Env,
  slots: readonly Slot[],
  fits: readonly BranchFit[],
  dirs: readonly Vec3[],
  eps: number,
): LegShifts | DerivationFailure {
  const offset: Vec3[] = dirs.map(() => ZERO);
  const reducers: string[][] = dirs.map(() => []);
  for (const slot of slots) {
    if (slot.offset === undefined) continue;
    offset[slot.leg] = add3(offset[slot.leg] as Vec3, slot.offset);
    (reducers[slot.leg] as string[]).push(slot.interval.id);
  }
  const start: number[] = dirs.map(() => 0);
  const warnings: DerivationWarning[] = [];
  for (let leg = 0; leg < dirs.length; leg++) {
    const d = offset[leg] as Vec3;
    if (!(len3(d) > eps)) {
      offset[leg] = ZERO;
      continue;
    }
    const next = dirs[leg + 1];
    const ids = [env.run.id, ...(reducers[leg] as string[])];
    const where = { leg, offsetMm: len3(d), offset: d };
    if (next === undefined)
      return fail(
        'RTE_ECCENTRIC_OFFSET',
        `leg ${leg} is the last leg of run ${env.run.id} and its eccentric reducers leave the axis ${+len3(d).toFixed(3)} mm off: there is no leg after them to take the offset up (a reducer needs an expander, or the reducer must sit before a turn)`,
        ids,
        [`inline`],
        where,
      );
    const along = dot3(d, next);
    const residual = len3(sub3(d, scale3(next, along)));
    const angleDeg = (Math.acos(Math.min(1, Math.abs(along) / len3(d))) * 180) / Math.PI;
    if (residual > Math.max(eps, 1e-6 * len3(d)) && angleDeg > env.tolerance.valueDeg)
      return fail(
        'RTE_ECCENTRIC_OFFSET',
        `the offset of the eccentric reducer(s) ${(reducers[leg] as string[]).join(', ')} on leg ${leg} of run ${env.run.id} is ${+len3(d).toFixed(3)} mm toward [${d.map((v) => +(v / len3(d)).toFixed(4)).join(', ')}], which leg ${leg + 1} (${+angleDeg.toFixed(3)} deg off the offset, tolerance ${env.tolerance.valueDeg} deg; direction [${next.map((v) => +v.toFixed(4)).join(', ')}]) cannot take up: the offset must run along the next leg (turn the flat side, or put the reducer on a leg followed by a turn along the flat)`,
        ids,
        [`inline`],
        { ...where, nextLeg: leg + 1, nextDirection: next, angleDeg, toleranceDeg: env.tolerance.valueDeg },
      );
    if (residual > Math.max(eps, 1e-6 * len3(d)))
      warnings.push({
        code: 'RTE_ECCENTRIC_OFFSET',
        ids: [env.run.id, ...(reducers[leg] as string[])],
        message: `leg ${leg}: the offset of the eccentric reducer(s) is ${+angleDeg.toFixed(4)} deg off leg ${leg + 1}; the ${+residual.toFixed(4)} mm sideways residual is dropped (within the ${env.tolerance.valueDeg} deg angle tolerance)`,
        detail: { leg, residualMm: residual, angleDeg, toleranceDeg: env.tolerance.valueDeg },
      });
    start[leg + 1] = along;
  }
  for (const fit of fits) {
    const first = slots.find((slot) => slot.offset !== undefined && slot.leg === fit.point.leg);
    if (first === undefined || (offset[fit.point.leg] as Vec3) === ZERO) continue;
    if (fit.point.distance > (first.interval.start + first.interval.end) / 2)
      return fail(
        'RTE_BRANCH_ON_FITTING',
        `branch ${fit.point.id} sits downstream of the eccentric reducer ${first.interval.id} on leg ${fit.point.leg}, where the axis is off the stored line: take branches off before the reducer or on another leg`,
        [env.run.id, fit.point.id, first.interval.id],
        ['branches'],
        { leg: fit.point.leg, distance: fit.point.distance },
      );
  }
  return { offset, start, warnings };
}
