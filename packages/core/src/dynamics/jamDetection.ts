/** A speed-governed motor that pushes at its torque limit while its joint does not turn: the mechanism has jammed. */

import type { DynamicsModel } from '../model/dynamics';
import { RAD_PER_S_PER_RPM } from './forceLaws';
import type { SimulationTrace } from './physicsEngine';

/** The last fraction of the run that is inspected. */
const TAIL_FRACTION = 0.25;
/** The mean speed over the tail is below this fraction of the target. */
const STALL_SPEED_FRACTION = 0.5;
/** The mean |torque| over the tail is at least this fraction of the limit. */
const SATURATION_FRACTION = 0.9;

/** A torque at or beyond this fraction of the limit counts as pinned at the limit. */
const PINNED_FRACTION = 0.99;
/** A motor pinned at its limit for more than this fraction of the samples cannot do what it was asked. */
const PINNED_RUN_FRACTION = 0.5;

/** A governed motor whose tail speed reaches this fraction of the target is doing its job even at its limit. */
const ON_TARGET_FRACTION = 0.95;

const mean = (values: readonly number[]): number => (values.length === 0 ? 0 : values.reduce((sum, v) => sum + v, 0) / values.length);

/**
 * Push a warning for every speed motor that is saturated and far below its target speed over the tail of the run (a jam), and for every
 * other speed motor (including rpm = 0 position holds) pinned at its torque limit for most of the run (undersized, or the hold is lost).
 */
export function warnJams(
  dynamics: DynamicsModel,
  trace: SimulationTrace,
  motorTorque: Readonly<Record<string, readonly number[]>>,
  warnings: string[],
): void {
  for (const motor of Object.values(dynamics.motors)) {
    if (motor.kind !== 'speed' || motor.maxTorque <= 0) continue;
    const speeds = trace.jointVelocity[motor.joint] ?? [];
    const torques = motorTorque[motor.id] ?? [];
    const count = Math.max(2, Math.floor(speeds.length * TAIL_FRACTION));
    if (speeds.length < 8) continue;
    const meanSpeed = mean(speeds.slice(-count)) / RAD_PER_S_PER_RPM;
    const meanTorque = mean(torques.slice(-count).map(Math.abs));
    const along = Math.sign(motor.rpm) * meanSpeed;
    const pinned = torques.filter((t) => Math.abs(t) >= PINNED_FRACTION * motor.maxTorque).length / Math.max(1, torques.length);
    const jammed =
      motor.rpm !== 0 && along < STALL_SPEED_FRACTION * Math.abs(motor.rpm) && meanTorque >= SATURATION_FRACTION * motor.maxTorque;
    const onTarget = motor.rpm !== 0 && along >= ON_TARGET_FRACTION * Math.abs(motor.rpm);
    if (!jammed && !onTarget && pinned > PINNED_RUN_FRACTION)
      warnings.push(
        `motor '${motor.id}' is pinned at its ${motor.maxTorque} N·m torque limit for ${(pinned * 100).toFixed(0)} % of the run ` +
          `(mean |torque| ${meanTorque.toFixed(1)} N·m, joint '${motor.joint}' at a mean ${meanSpeed.toFixed(1)} rpm against ${motor.rpm} rpm): ` +
          `it is too weak to ${motor.rpm === 0 ? 'hold the joint against its load' : 'reach its speed'} — raise maxTorque or reduce the load`,
      );
    if (jammed)
      warnings.push(
        `motor '${motor.id}' sits at its ${motor.maxTorque} N·m limit (mean ${meanTorque.toFixed(1)} N·m) while joint '${motor.joint}' turns at a mean ` +
          `${meanSpeed.toFixed(1)} rpm against ${motor.rpm} rpm: toggle / lock-up detected — the mechanism cannot complete a turn ` +
          `(a non-Grashof four-bar stalls at a toggle, or a hard stop or an overload blocks the crank)`,
      );
  }
}
