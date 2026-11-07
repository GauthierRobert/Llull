/**
 * Discrete drive controllers (PHY-23 TR-DRV-10 / 11): a velocity PI (with an optional position P loop in cascade) held for one sample period,
 * and the high-gain prescribed-motion servo. They output a torque command on the controlled joint; the motor turns it into a current.
 * All state lives in the actuator `aux` array (pure: no closure state).
 */

import type { CompiledProfile } from '@core/geometry/motionProfile';

/** Slots of one datasheet motor in the actuator `aux` array, relative to the motor's base index. */
export const AUX = {
  current: 0,
  voltage: 1,
  meanCurrent: 2,
  shaftTorque: 3,
  integrator: 4,
  heldTorque: 5,
  jointTorque: 6,
  steps: 7,
  limited: 8,
  reference: 9,
  measured: 10,
  /** 1 when the realized current was clipped by the current limit or the bus voltage in the last step. */
  clipped: 11,
  /** W: electrical input power of the step (all phases). */
  power: 12,
  /** stepper: continuous commanded motor-shaft angle (position profile or the integral of the step rate), rad. */
  command: 13,
  /** stepper: angle offset that aligns the first step with the rotor, rad. */
  offset: 14,
  /** stepper: electrical lag N_r·(θ_cmd − θ), rad. */
  lag: 15,
  /** stepper: net full steps lost so far (whole electrical periods of 4 steps). */
  lostSteps: 16,
  /** stepper: time of the first lost step, s; −1 while none. */
  lostTime: 17,
  /** induction: supply frequency of the step, Hz. */
  frequency: 18,
} as const;
export const AUX_SIZE = 19;

export interface LoopGains {
  /** N·m per rad/s (or N per m/s). */
  readonly kp: number;
  readonly ki: number;
  /** 1/s: rad/s of velocity command per rad of position error. */
  readonly kpPosition: number;
}

/** Velocity PI from a bandwidth f_c (Hz) and damping ratio ζ on the reflected inertia: k_p = 2ζω_c·J, k_i = ω_c²·J, k_p,pos = ω_c / 4. */
export function tunedGains(inertia: number, bandwidthHz: number, dampingRatio: number): LoopGains {
  const wc = 2 * Math.PI * bandwidthHz;
  return { kp: 2 * dampingRatio * wc * inertia, ki: wc * wc * inertia, kpPosition: wc / 4 };
}

/** The largest ω_c·T_s the discrete loop tolerates (TR-DRV-10). */
export const MAX_BANDWIDTH_PER_RATE = 0.2;

/** Natural frequency of the prescribed-motion servo in rad per step: ω_n·dt. */
const PRESCRIBED_RAD_PER_STEP = 0.1;

type LoopMode = 'velocity' | 'position' | 'prescribed';

export interface LoopSpec {
  readonly mode: LoopMode;
  readonly profile: CompiledProfile;
  /** Profile unit to SI. */
  readonly scale: number;
  readonly quantity: 'position' | 'velocity';
  readonly gains: LoopGains;
  readonly feedforward: boolean;
  /** kg·m²: inertia seen by the controlled joint (bodies + armature). */
  readonly inertia: number;
  /** Controller period in steps (1 for prescribed). */
  readonly periodSteps: number;
  /** N·m: command limit. */
  readonly torqueLimit: number;
}

const clamp = (value: number, limit: number): number => Math.min(limit, Math.max(-limit, value));

/**
 * Update the held torque command of a loop at time `time` from the measured joint position `q` and velocity `v`; `slot` is the motor's base
 * index in `aux` (mutated: the caller passes its own copy). The command is recomputed once per `periodSteps` steps (zero-order hold).
 */
export function updateLoop(spec: LoopSpec, aux: Float64Array, slot: number, time: number, q: number, v: number, dt: number): void {
  const step = aux[slot + AUX.steps] ?? 0;
  aux[slot + AUX.measured] = spec.quantity === 'position' ? q : v;
  if (step % spec.periodSteps !== 0) return;
  const reference = spec.profile.evaluate(time);
  const [value, derivative, second] = [reference.value * spec.scale, reference.velocity * spec.scale, reference.acceleration * spec.scale];
  aux[slot + AUX.reference] = value;
  if (spec.mode === 'prescribed') {
    const wn = PRESCRIBED_RAD_PER_STEP / dt;
    const command =
      spec.quantity === 'position'
        ? spec.inertia * (wn * wn * (value - q) + 2 * wn * (derivative - v) + second)
        : spec.inertia * wn * (value - v) + spec.inertia * derivative;
    aux[slot + AUX.heldTorque] = clamp(command, spec.torqueLimit);
    return;
  }
  const speedReference = spec.quantity === 'position' ? spec.gains.kpPosition * (value - q) + (spec.feedforward ? derivative : 0) : value;
  const feedforward = spec.feedforward ? spec.inertia * (spec.quantity === 'position' ? second : derivative) : 0;
  const error = speedReference - v;
  const integrator = aux[slot + AUX.integrator] ?? 0;
  const unsaturated = spec.gains.kp * error + integrator + feedforward;
  const held = aux[slot + AUX.heldTorque] ?? 0;
  const commandClipped = Math.abs(unsaturated) > spec.torqueLimit && Math.sign(error) === Math.sign(unsaturated);
  // the realized current was cut by the limit or the bus voltage although the loop asked for more in the direction of the error
  const realizedClipped = (aux[slot + AUX.clipped] ?? 0) > 0 && Math.sign(error) === Math.sign(held);
  const pushing = commandClipped || realizedClipped;
  const next = pushing ? integrator : integrator + spec.gains.ki * error * spec.periodSteps * dt;
  aux[slot + AUX.integrator] = next;
  aux[slot + AUX.heldTorque] = clamp(spec.gains.kp * error + next + feedforward, spec.torqueLimit);
}
