/**
 * Integration timestep of loop-closed / engine mechanisms (TR-FPR §5.3): the explicit request wins, then the stored solver setting, then
 * the `auto` rule min(1 ms, 0.5 deg of crank at the highest expected speed). Loop-free models without cylinders keep the legacy 1 ms.
 */

import type { DynamicsModel, DynamicsSolverSettings } from '@core/model/dynamics';
import { RAD_PER_S_PER_RPM } from './forceLaws';

/** Legacy default step, s. */
const DEFAULT_TIMESTEP = 0.001;
/** Largest crank rotation per step in the auto rule: 0.5 deg. */
const AUTO_STEP_ANGLE_RAD = (0.5 * Math.PI) / 180;
/** Smallest step the command accepts, s. */
const MIN_TIMESTEP = 1e-5;
/** Pilot-run margin on the highest speed reached when no governor or torque curve gives a speed (named). */
const PILOT_SPEED_MARGIN = 1.2;
/** Pilot run: length (s) and step (s). */
export const PILOT_DURATION = 0.2;
export const PILOT_TIMESTEP = 1e-4;

/** Highest shaft speed (rad/s) the drives and initial speeds of `dynamics` announce; 0 when none does. */
export function announcedSpeed(dynamics: DynamicsModel): number {
  const rpms = Object.values(dynamics.motors).map((motor) =>
    motor.kind === 'speed' ? motor.rpm : Math.max(...motor.curve.map((p) => p[0])),
  );
  const initial = Object.values(dynamics.joints).flatMap((joint) => (joint.kind === 'revolute' ? [Math.abs(joint.initialVelocity)] : []));
  return Math.max(0, ...rpms.map((rpm) => Math.abs(rpm) * RAD_PER_S_PER_RPM), ...initial);
}

export interface ResolvedTimestep {
  readonly timestep: number;
  /** Where the value came from, reported in provenance. */
  readonly basis: string;
  /** Highest crank speed the auto rule used (rad/s), 0 when not applicable (models without loops or cylinders). */
  readonly maxSpeed: number;
}

/**
 * @param requested the `timestep` parameter of the call
 * @param structured the model has loops or cylinders (solver settings apply)
 * @param pilotPeakSpeed runs the 0.2 s pilot and returns the highest |joint speed| (rad/s); only called when no speed is announced
 */
export function resolveTimestep(
  dynamics: DynamicsModel,
  settings: DynamicsSolverSettings,
  requested: number | undefined,
  structured: boolean,
  pilotPeakSpeed: () => number,
): ResolvedTimestep {
  if (requested !== undefined) return { timestep: requested, basis: 'requested by the call', maxSpeed: announcedSpeed(dynamics) };
  if (!structured) return { timestep: DEFAULT_TIMESTEP, basis: 'default 1 ms', maxSpeed: 0 };
  if (settings.timestepS !== 'auto')
    return { timestep: settings.timestepS, basis: 'set_dynamics_solver timestepS', maxSpeed: announcedSpeed(dynamics) };
  let omega = announcedSpeed(dynamics);
  let basis = 'auto: min(1 ms, 0.5 deg of crank at the announced top speed)';
  if (omega === 0) {
    omega = PILOT_SPEED_MARGIN * pilotPeakSpeed();
    basis = `auto: min(1 ms, 0.5 deg of crank at ${PILOT_SPEED_MARGIN} x the top speed of a ${PILOT_DURATION} s pilot run)`;
  }
  const step = omega > 0 ? Math.min(DEFAULT_TIMESTEP, AUTO_STEP_ANGLE_RAD / omega) : DEFAULT_TIMESTEP;
  return { timestep: Math.max(MIN_TIMESTEP, step), basis, maxSpeed: omega };
}
