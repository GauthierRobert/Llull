/**
 * Force laws of the document's drives and loads, engine-independent and pure: the engine calls `appliedLoads` every step, the report
 * re-evaluates the same functions on the recorded samples.
 */

import type { Motor, PropellerLoad, TorquePoint } from '../model/dynamics';
import type { Vec3 } from '../model/vectors';
import type { AppliedLoads, SimulationState } from './physicsEngine';

export const RAD_PER_S_PER_RPM = (2 * Math.PI) / 60;

/** Torque (N·m) of a curve at `rpm`: linear between points (sorted by rpm), held at the first/last value outside them. */
function curveTorque(curve: readonly TorquePoint[], rpm: number): number {
  const first = curve[0];
  const lastPoint = curve[curve.length - 1];
  if (first === undefined || lastPoint === undefined) return 0;
  if (rpm <= first[0]) return first[1];
  if (rpm >= lastPoint[0]) return lastPoint[1];
  for (let i = 1; i < curve.length; i++) {
    const [r1, t1] = curve[i - 1] ?? first;
    const [r2, t2] = curve[i] ?? lastPoint;
    if (rpm <= r2) return r2 === r1 ? t2 : t1 + ((t2 - t1) * (rpm - r1)) / (r2 - r1);
  }
  return lastPoint[1];
}

type TorqueMotor = Extract<Motor, { kind: 'torque_curve' }>;

/**
 * Gains of a speed motor's governor, a critically damped servo on the angle that advances at the target speed (so the steady speed error
 * is zero whatever the load below maxTorque): natural frequency 1 / (8 · timestep), well inside what the step resolves, scaled by the
 * inertia it drives. stiffness N·m/rad, damping N·m·s/rad.
 */
export function speedServoGains(jointInertia: number, timestep: number): { stiffness: number; damping: number } {
  const naturalFrequency = 1 / (8 * timestep);
  return { stiffness: jointInertia * naturalFrequency ** 2, damping: 2 * jointInertia * naturalFrequency };
}

/** Drive torque (N·m) or force (N) of a torque-curve motor at joint speed `velocity` (rad/s or m/s). */
export function motorForce(motor: TorqueMotor, velocity: number): number {
  return motor.throttle * curveTorque(motor.curve, velocity / RAD_PER_S_PER_RPM);
}

export interface PropellerOutput {
  /** N, along the thrust direction. */
  readonly thrust: number;
  /** N·m drag torque magnitude. */
  readonly torque: number;
  /** W absorbed from the shaft. */
  readonly power: number;
}

/** Static propeller law at shaft speed `omega` (rad/s): T = Ct·ρ·n²·D⁴, P = Cp·ρ·|n|³·D⁵, Q = P/(2π|n|) = Cp·ρ·n²·D⁵/(2π). */
export function propellerOutput(propeller: PropellerLoad, omega: number): PropellerOutput {
  const n = omega / (2 * Math.PI);
  const { airDensity: rho, diameter: d } = propeller;
  const torque = (propeller.powerCoefficient * rho * n * n * d ** 5) / (2 * Math.PI);
  return { thrust: propeller.thrustCoefficient * rho * n * n * d ** 4, torque, power: torque * Math.abs(omega) };
}

function unit(v: Vec3): Vec3 {
  const length = Math.hypot(v[0], v[1], v[2]);
  return length > 0 ? [v[0] / length, v[1] / length, v[2] / length] : [0, 0, 0];
}

/**
 * The `loads` callback of a simulation: torque-curve motors push their joints (speed motors are engine servos), propellers brake theirs (torque against the rotation) and push the
 * spinning body along their thrust direction. `bodyOfJoint` maps a joint to its moving (child) body.
 */
export function appliedLoadsFor(
  motors: readonly Motor[],
  propellers: readonly PropellerLoad[],
  bodyOfJoint: Readonly<Record<string, string>>,
): (state: SimulationState) => AppliedLoads {
  return (state) => {
    const jointForces: Record<string, number> = {};
    const bodyForces: Record<string, Vec3> = {};
    const add = (joint: string, value: number): void => {
      jointForces[joint] = (jointForces[joint] ?? 0) + value;
    };
    for (const motor of motors)
      if (motor.kind === 'torque_curve') add(motor.joint, motorForce(motor, state.jointVelocity[motor.joint] ?? 0));
    for (const propeller of propellers) {
      const omega = state.jointVelocity[propeller.joint] ?? 0;
      const output = propellerOutput(propeller, omega);
      add(propeller.joint, -Math.sign(omega) * output.torque);
      const body = bodyOfJoint[propeller.joint];
      if (body === undefined) continue;
      const direction = unit(propeller.thrustDirection);
      const previous = bodyForces[body] ?? [0, 0, 0];
      bodyForces[body] = [
        previous[0] + direction[0] * output.thrust,
        previous[1] + direction[1] * output.thrust,
        previous[2] + direction[2] * output.thrust,
      ];
    }
    return { jointForces, bodyForces };
  };
}
