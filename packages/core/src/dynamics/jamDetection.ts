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

const mean = (values: readonly number[]): number => (values.length === 0 ? 0 : values.reduce((sum, v) => sum + v, 0) / values.length);

/** Push a warning for every speed motor that is saturated and far below its target speed over the tail of the run. */
export function warnJams(
  dynamics: DynamicsModel,
  trace: SimulationTrace,
  motorTorque: Readonly<Record<string, readonly number[]>>,
  warnings: string[],
): void {
  for (const motor of Object.values(dynamics.motors)) {
    if (motor.kind !== 'speed' || motor.rpm === 0 || motor.maxTorque <= 0) continue;
    const speeds = trace.jointVelocity[motor.joint] ?? [];
    const torques = motorTorque[motor.id] ?? [];
    const count = Math.max(2, Math.floor(speeds.length * TAIL_FRACTION));
    if (speeds.length < 8) continue;
    const meanSpeed = mean(speeds.slice(-count)) / RAD_PER_S_PER_RPM;
    const meanTorque = mean(torques.slice(-count).map(Math.abs));
    const along = Math.sign(motor.rpm) * meanSpeed;
    if (along < STALL_SPEED_FRACTION * Math.abs(motor.rpm) && meanTorque >= SATURATION_FRACTION * motor.maxTorque)
      warnings.push(
        `motor '${motor.id}' sits at its ${motor.maxTorque} N·m limit (mean ${meanTorque.toFixed(1)} N·m) while joint '${motor.joint}' turns at a mean ` +
          `${meanSpeed.toFixed(1)} rpm against ${motor.rpm} rpm: toggle / lock-up detected — the mechanism cannot complete a turn ` +
          `(a non-Grashof four-bar stalls at a toggle, or a hard stop or an overload blocks the crank)`,
      );
  }
}
