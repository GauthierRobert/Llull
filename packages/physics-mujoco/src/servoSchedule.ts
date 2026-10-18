/**
 * Gain scheduling of the speed governors. A governor is a PD servo whose explicit RK4 stability needs kp / I_eff · dt^2 and kv / I_eff · dt
 * bounded, where I_eff is the inertia the servo really drives. That is not the inertia of the bodies it carries: free joints below it,
 * loops, gears and a parent that moves all change it, by factors of 10 or more, and it varies with the configuration. I_eff is therefore
 * measured: a unit generalised force on the servo's DOF changes the constrained acceleration (constraint forces included) by
 * e^T M_c^-1 e = 1 / I_eff, with M_c^-1 = M^-1 - M^-1 J^T (J M^-1 J^T)^-1 J M^-1 the inverse mass matrix projected on the equality
 * constraints, so two forward passes give it: I_eff = 1 / (qacc[dof](F + 1) - qacc[dof](F)). The gains are then kp = I_eff · wn^2 and
 * kv = 2 I_eff · wn with wn the model's `naturalFrequency`, which pins the servo pole at wn · dt for every configuration.
 */

import type { SimulationModel } from '@core/dynamics/physicsEngine';
import type { MjData, MjModel, MujocoModule } from './bindings';

/** Parameters per actuator in actuator_gainprm / actuator_biasprm. */
const PARAMETERS = 10;

export interface ServoGains {
  stiffness: number;
  damping: number;
}

/**
 * Gains in force, one entry per servo of `model`, starting at the static values of the model. `update()` re-measures I_eff at the current
 * state of `data` (with the loads of the coming step already in `qfrc_applied`) and writes the scheduled gains into the MuJoCo actuators;
 * a servo without `naturalFrequency` or whose response cannot be measured keeps its current gains.
 */
export function createServoSchedule(
  mujoco: MujocoModule,
  mjModel: MjModel,
  data: MjData,
  model: SimulationModel,
  dofs: readonly (number | undefined)[],
): { gains: ServoGains[]; update: () => void } {
  const gains: ServoGains[] = model.servos.map((servo) => ({ stiffness: servo.stiffness, damping: servo.damping }));
  const scheduled = model.servos.map((servo, i) => (servo.naturalFrequency ?? 0) > 0 && dofs[i] !== undefined);
  const write = (i: number): void => {
    const gain = gains[i];
    if (gain === undefined) return;
    mjModel.actuator_gainprm[i * PARAMETERS] = gain.stiffness;
    mjModel.actuator_biasprm[i * PARAMETERS + 1] = -gain.stiffness;
    mjModel.actuator_biasprm[i * PARAMETERS + 2] = -gain.damping;
  };
  const update = (): void => {
    if (!scheduled.includes(true)) return;
    mujoco.mj_forward(mjModel, data);
    const rest = model.servos.map((_, i) => data.qacc[dofs[i] ?? 0] ?? 0);
    model.servos.forEach((servo, i) => {
      const dof = dofs[i];
      const gain = gains[i];
      if (!scheduled[i] || dof === undefined || gain === undefined) return;
      const held = data.qfrc_applied[dof] ?? 0;
      data.qfrc_applied[dof] = held + 1;
      mujoco.mj_forward(mjModel, data);
      data.qfrc_applied[dof] = held;
      const response = (data.qacc[dof] ?? 0) - (rest[i] ?? 0);
      if (!(response > 0) || !Number.isFinite(response)) return;
      const [inertia, wn] = [1 / response, servo.naturalFrequency ?? 0];
      gain.stiffness = inertia * wn * wn;
      gain.damping = 2 * inertia * wn;
      write(i);
    });
  };
  return { gains, update };
}
