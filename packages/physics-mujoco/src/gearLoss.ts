/**
 * Mesh efficiency of gear couplings (FR-FPR-74, TR-FPR-17). A gear is a rigid joint equality, so the constraint transmits the ideal torque;
 * the loss (1 - efficiency) |T| is applied as a load on the driven joint against its velocity, with T the torque the equality row puts on the
 * driven coordinate (efc_J . efc_force of the previous step's loads, read from a forward pass at the start of each step).
 */

import type { SimulationModel } from '@core/dynamics/physicsEngine';
import { CONSTRAINT_EQUALITY, OBJECT_EQUALITY, type MjData, type MjModel, type MujocoModule } from './bindings';

/** Speed scale of the sign smoothing of the loss torque (rad/s or m/s), the same as the engine friction (TR-FPR-15). */
const SMOOTHING_SPEED = 1;

export interface GearLossSlot {
  /** MuJoCo equality index of the gear. */
  readonly equality: number;
  readonly drivenDof: number;
  readonly loss: number;
}

/** Slots of the gears that lose power; `dofOf` maps a joint id to its velocity address. */
export function gearLossSlots(
  mujoco: MujocoModule,
  mjModel: MjModel,
  model: SimulationModel,
  dofOf: (jointId: string) => number | undefined,
): GearLossSlot[] {
  return model.gears.flatMap((gear) => {
    const efficiency = gear.efficiency ?? 1;
    const dof = dofOf(gear.driven);
    if (!(efficiency < 1) || dof === undefined) return [];
    const equality = mujoco.mj_name2id(mjModel, OBJECT_EQUALITY, gear.id);
    return equality < 0 ? [] : [{ equality, drivenDof: dof, loss: 1 - Math.max(efficiency, 0) }];
  });
}

/**
 * Add the loss torques to `qfrc_applied` for the state of `data` (after `mj_forward`): per gear, loss * |T_driven| * tanh(v_driven / v_s)
 * against the driven velocity.
 */
export function addGearLoss(mjModel: MjModel, data: MjData, slots: readonly GearLossSlot[]): void {
  const nv = mjModel.nv;
  for (const slot of slots) {
    let transmitted = 0;
    for (let row = 0; row < data.nefc; row++)
      if (data.efc_type[row] === CONSTRAINT_EQUALITY && data.efc_id[row] === slot.equality)
        transmitted += (data.efc_J[row * nv + slot.drivenDof] ?? 0) * (data.efc_force[row] ?? 0);
    const velocity = data.qvel[slot.drivenDof] ?? 0;
    data.qfrc_applied[slot.drivenDof] =
      (data.qfrc_applied[slot.drivenDof] ?? 0) - slot.loss * Math.abs(transmitted) * Math.tanh(velocity / SMOOTHING_SPEED);
  }
}
