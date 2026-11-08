/**
 * The flight slice compiled for one run and added to the `loads` callback: rotors and body drag read the body state the engine passes
 * (`SimulationState.bodies`) and return world forces at the centres of mass plus moments about them.
 */

import type { AppliedLoads, BodyKinematics, SimulationState } from '@core/dynamics/physicsEngine';
import type { CadDocument } from '@core/model/types';
import type { Vec3 } from '@core/model/vectors';
import { add3 } from '@lib/vec3';
import type { BodyDrag } from './model';
import { bodyDragForce, compileRotor, rotorOutput, type RotorRuntime } from './rotorLaw';
import { airRelative } from './wind';

type Loads = (state: SimulationState) => AppliedLoads;

export interface FlightRuntime {
  readonly rotors: readonly RotorRuntime[];
  readonly drags: readonly BodyDrag[];
  /** Bodies whose state the laws read (the model's `bodyStates`). */
  readonly bodies: readonly string[];
}

/**
 * The flight records of `doc` against the bodies of the run (`centerOfMass` in metres, world at the modelled pose), null when the document has
 * none, or why a record cannot act (its body is missing or fixed).
 */
export function compileFlight(
  doc: CadDocument,
  centerOfMass: Readonly<Record<string, Vec3>>,
  metresPerUnit: number,
): FlightRuntime | null | { error: string } {
  const flight = doc.flight;
  const rotors = Object.values(flight?.rotors ?? {});
  const drags = Object.values(flight?.bodyDrag ?? {});
  if (rotors.length === 0 && drags.length === 0) return null;
  const bodies = doc.dynamics?.bodies ?? {};
  for (const [what, bodyId] of [
    ...rotors.map((rotor) => [`rotor '${rotor.id}'`, rotor.bodyId] as const),
    ...drags.map((drag) => [`body drag of '${drag.bodyId}'`, drag.bodyId] as const),
  ]) {
    const body = Object.hasOwn(bodies, bodyId) ? bodies[bodyId] : undefined;
    if (body === undefined || !Object.hasOwn(centerOfMass, bodyId))
      return { error: `${what} acts on '${bodyId}', which is not a rigid body` };
    if (body.fixed) return { error: `${what} acts on '${bodyId}', which is fixed to the ground` };
  }
  return {
    rotors: rotors.map((rotor) => compileRotor(rotor, centerOfMass[rotor.bodyId] ?? [0, 0, 0], metresPerUnit)),
    drags,
    bodies: [...new Set([...rotors.map((rotor) => rotor.bodyId), ...drags.map((drag) => drag.bodyId)])],
  };
}

/**
 * `base` plus the rotor and drag wrenches of `runtime` (a body the engine gave no state for gets none); with `wind` (world air velocity, m/s,
 * at time t) the laws read the body velocity relative to the air.
 */
export function withFlightLoads(base: Loads, runtime: FlightRuntime, wind?: (time: number) => Vec3): Loads {
  return (state) => {
    const loads = base(state);
    const bodyForces: Record<string, Vec3> = { ...loads.bodyForces };
    const bodyMoments: Record<string, Vec3> = { ...loads.bodyMoments };
    const air = wind?.(state.time);
    const stateOf = (id: string): BodyKinematics | undefined => {
      const body = state.bodies?.[id];
      return body === undefined || air === undefined ? body : airRelative(body, air);
    };
    for (const rotor of runtime.rotors) {
      const body = stateOf(rotor.rotor.bodyId);
      if (body === undefined) continue;
      const output = rotorOutput(rotor, body);
      const id = rotor.rotor.bodyId;
      bodyForces[id] = add3(bodyForces[id] ?? [0, 0, 0], output.force);
      bodyMoments[id] = add3(bodyMoments[id] ?? [0, 0, 0], output.moment);
    }
    for (const drag of runtime.drags) {
      const body = stateOf(drag.bodyId);
      if (body === undefined) continue;
      bodyForces[drag.bodyId] = add3(bodyForces[drag.bodyId] ?? [0, 0, 0], bodyDragForce(drag, body));
    }
    return { jointForces: loads.jointForces, bodyForces, bodyMoments };
  };
}
