/**
 * Load schedules (PHY-23 FR-DRV-14): a time profile or a constant applied as the force on a body (world axes, at its centre of mass) or as the
 * generalised force of a joint, added to the `loads` callback of the simulation. Pure: the value at time t comes from the compiled profile.
 */

import type { AppliedLoads, SimulationState } from '@core/dynamics/physicsEngine';
import { compileProfile, isProfileRefusal, profileUnitScale, type CompiledProfile } from '@core/geometry/motionProfile';
import type { DynamicsModel } from '@core/model/dynamics';
import type { LoadSchedule } from '@core/model/transmissions';
import type { Vec3 } from '@core/model/vectors';

type Loads = (state: SimulationState) => AppliedLoads;

interface Runtime {
  readonly schedule: LoadSchedule;
  readonly value: (time: number) => number;
  readonly direction: Vec3;
}

const unit = (v: Vec3): Vec3 => {
  const length = Math.hypot(v[0], v[1], v[2]);
  return length > 0 ? [v[0] / length, v[1] / length, v[2] / length] : [0, 0, 0];
};

/** The profile of a schedule resolved to SI, or why not. */
function valueOf(dynamics: DynamicsModel, schedule: LoadSchedule): ((time: number) => number) | { error: string } {
  if (schedule.profile === undefined) return () => schedule.constant ?? 0;
  const stored = dynamics.profiles?.[schedule.profile];
  if (stored === undefined) return { error: `load '${schedule.id}': profile '${schedule.profile}' not found` };
  if (stored.quantity !== schedule.kind)
    return { error: `load '${schedule.id}' is a ${schedule.kind}, profile '${stored.id}' is a ${stored.quantity} profile` };
  const compiled: CompiledProfile | ReturnType<typeof compileProfile> = compileProfile(stored);
  const scale = profileUnitScale(stored.quantity, stored.unit);
  if (isProfileRefusal(compiled) || scale === null) return { error: `load '${schedule.id}': profile '${stored.id}' cannot be evaluated` };
  return (time) => compiled.evaluate(time).value * scale;
}

/** `base` plus the document's load schedules; `sign` is -1 for a joint whose simulated coordinate is the reverse of the document's. */
export function withLoadSchedules(base: Loads, dynamics: DynamicsModel, sign: (jointId: string) => number): Loads | { error: string } {
  const runtimes: Runtime[] = [];
  for (const schedule of Object.values(dynamics.loadSchedules ?? {})) {
    const value = valueOf(dynamics, schedule);
    if (typeof value !== 'function') return value;
    runtimes.push({ schedule, value, direction: unit(schedule.direction ?? [0, 0, 0]) });
  }
  if (runtimes.length === 0) return base;
  return (state) => {
    const loads = base(state);
    const jointForces: Record<string, number> = { ...loads.jointForces };
    const bodyForces: Record<string, Vec3> = { ...loads.bodyForces };
    for (const { schedule, value, direction } of runtimes) {
      const magnitude = value(state.time);
      if ('joint' in schedule.target) {
        const joint = schedule.target.joint;
        jointForces[joint] = (jointForces[joint] ?? 0) + sign(joint) * magnitude;
      } else {
        const body = schedule.target.body;
        const held = bodyForces[body] ?? [0, 0, 0];
        bodyForces[body] = [held[0] + direction[0] * magnitude, held[1] + direction[1] * magnitude, held[2] + direction[2] * magnitude];
      }
    }
    return { jointForces, bodyForces };
  };
}
