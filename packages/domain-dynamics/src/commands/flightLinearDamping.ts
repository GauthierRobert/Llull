/** Rate damping and the aero warnings of linearize_flight (13 FLT M5b): the tail-arm terms at the trim and what the linearisation leaves out. */

import { rateDampingTerms, type RateDampingSkip, type RateDampingTerm } from '../flight/rateDamping';
import { controlSettings, wrenchAt, type TrimVehicle } from '../flight/trimModel';
import { bodyVelocity, type TrimCondition, type TrimState } from '../flight/trimSolve';

export interface LinearDamping {
  readonly requested: 'none' | 'tail_arm';
  /** What A carries: `tail_arm` when at least one term was applied. */
  readonly method: 'none' | 'tail_arm';
  readonly terms: readonly RateDampingTerm[];
  /** Servo tables asked for the estimate and refused it, with why. */
  readonly skipped: readonly RateDampingSkip[];
}

/** The rate damping of `requested` at the trim (every surface's trim angle of attack, its pivot the control value or its neutral). */
export function linearDamping(
  vehicle: TrimVehicle,
  condition: TrimCondition,
  state: TrimState,
  requested: 'none' | 'tail_arm',
): LinearDamping {
  if (requested === 'none') return { requested, method: 'none', terms: [], skipped: [] };
  const velocity = bodyVelocity(condition.airspeedMps, state.flightPath, state.roll, state.pitch);
  const wrench = wrenchAt(vehicle, { velocity, rates: [0, 0, 0], roll: state.roll, pitch: state.pitch }, state.controls);
  const { terms, skipped } = rateDampingTerms(
    vehicle,
    wrench.aero.map((output) => output.alphaDeg),
    controlSettings(vehicle, state.controls).pivot,
  );
  return { requested, method: terms.length > 0 ? 'tail_arm' : 'none', terms, skipped };
}

/** What the linearisation of an aero vehicle does not model (FLT-D30) and what its rate damping is. */
export function aeroWarnings(vehicle: TrimVehicle, damping: LinearDamping): string[] {
  if (vehicle.aero.length === 0) return [];
  const lateral =
    'the aero tables have no sideslip, roll-rate or yaw-rate dependence (FLT-D30): the lateral roots of an aero vehicle are neutral by construction (labelled lateral_neutral), not a stability result';
  const skipped = damping.skipped.map((skip) => `; tail-arm estimate not applied to '${skip.surfaceId}': ${skip.reason}`).join('');
  if (damping.terms.length === 0)
    return [
      `${lateral}; longitudinal rate damping (Mq, Zq, Malpha-dot) is absent too (each surface is lumped at its moment centre; rateDamping "${damping.requested}"${skipped}), so neither the DAMPING nor, where Zw Mq is comparable with Malpha (a light wing loading), the PERIODS of the phugoid and short period are stability results: rateDamping "tail_arm" adds the tail-arm estimate for a pivoting tail`,
    ];
  return [
    lateral,
    `longitudinal rate damping (Zq, Mq, Malpha-dot) of ${damping.terms.map((term) => `'${term.surfaceId}'`).join(', ')} is the tail-arm estimate (tail arm ${damping.terms.map((term) => term.tailArmM.toPrecision(3)).join(', ')} m from the pivot derivatives; Nelson ch. 3): an estimate for an all-moving tail in attached, quasi-steady flow without the wing and fuselage rate terms, not a lattice result; run_flight does not apply it (pending owner decision), so this A is not the Jacobian of what run_flight integrates${skipped}`,
  ];
}
