/**
 * Reading constraint forces out of MuJoCo: loop forces from the `connect` equality rows, tree-joint reactions from `cfrc_int` moved to the
 * joint anchor, and the loop residual from `efc_pos`. All world axes, SI.
 */

import type { SimulationLoop } from '@core/dynamics/physicsEngine';
import type { Vec3 } from '@core/model/vectors';
import { CONSTRAINT_EQUALITY, OBJECT_EQUALITY, type MjData, type MjModel, type MujocoModule } from './bindings';
import { loopEqualityName, loopPinCount } from './mjcf';

export interface LoopSlot {
  readonly id: string;
  /** MuJoCo equality indices of the loop's pins. */
  readonly equalities: readonly number[];
}

export interface ReactionSlot {
  readonly jointId: string;
  readonly bodyIndex: number;
  readonly jointIndex: number;
}

export function loopSlots(mujoco: MujocoModule, model: MjModel, loops: readonly SimulationLoop[]): LoopSlot[] {
  return loops.map((loop) => ({
    id: loop.id,
    equalities: Array.from({ length: loopPinCount(loop) }, (_, pin) => {
      const index = mujoco.mj_name2id(model, OBJECT_EQUALITY, loopEqualityName(loop.id, pin));
      if (index < 0) throw new Error(`MuJoCo model has no loop constraint for '${loop.id}'.`);
      return index;
    }),
  }));
}

/** Loop index of every equality that belongs to a loop. */
function equalityOwners(slots: readonly LoopSlot[]): Map<number, number> {
  return new Map(slots.flatMap((slot, loop) => slot.equalities.map((equality) => [equality, loop] as const)));
}

export interface LoopReader {
  /** Force each loop exerts on its bodyB, N (call after `mj_forward`). */
  forces(data: MjData): Vec3[];
  /** Largest |constraint violation| over the loops' rows now, m. */
  residual(data: MjData): number;
}

export function loopReader(slots: readonly LoopSlot[]): LoopReader {
  const owner = equalityOwners(slots);
  return {
    forces(data) {
      const total = slots.map((): [number, number, number] => [0, 0, 0]);
      const [types, ids, force] = [data.efc_type, data.efc_id, data.efc_force];
      // each connect contributes 3 consecutive rows (x, y, z); the force on body2 is minus the multiplier
      const counts = new Map<number, number>();
      for (let row = 0; row < data.nefc; row++) {
        const equality = ids[row] ?? -1;
        const loop = types[row] === CONSTRAINT_EQUALITY ? owner.get(equality) : undefined;
        if (loop === undefined) continue;
        const component = counts.get(equality) ?? 0;
        counts.set(equality, component + 1);
        const sum = total[loop];
        if (sum !== undefined) sum[component % 3] = (sum[component % 3] ?? 0) - (force[row] ?? 0);
      }
      return total;
    },
    residual(data) {
      const [types, ids, position] = [data.efc_type, data.efc_id, data.efc_pos];
      let worst = 0;
      for (let row = 0; row < data.nefc; row++)
        if (types[row] === CONSTRAINT_EQUALITY && owner.has(ids[row] ?? -1)) worst = Math.max(worst, Math.abs(position[row] ?? 0));
      return worst;
    },
  };
}

/**
 * Force and moment the tree parent exerts on the body of a tree joint, at the joint anchor. `cfrc_int` is the interaction force with the
 * parent about the root subtree COM; the moment at the anchor p is tau + (c - p) x f.
 */
export function jointReaction(model: MjModel, data: MjData, slot: ReactionSlot): { force: Vec3; moment: Vec3 } {
  const b = 6 * slot.bodyIndex;
  const [tau, f] = [[0, 1, 2].map((i) => data.cfrc_int[b + i] ?? 0), [0, 1, 2].map((i) => data.cfrc_int[b + 3 + i] ?? 0)];
  const root = 3 * (model.body_rootid[slot.bodyIndex] ?? 0);
  const arm = [0, 1, 2].map((i) => (data.subtree_com[root + i] ?? 0) - (data.xanchor[3 * slot.jointIndex + i] ?? 0));
  const [fx, fy, fz] = [f[0] ?? 0, f[1] ?? 0, f[2] ?? 0];
  return {
    force: [fx, fy, fz],
    moment: [
      (tau[0] ?? 0) + (arm[1] ?? 0) * fz - (arm[2] ?? 0) * fy,
      (tau[1] ?? 0) + (arm[2] ?? 0) * fx - (arm[0] ?? 0) * fz,
      (tau[2] ?? 0) + (arm[0] ?? 0) * fy - (arm[1] ?? 0) * fx,
    ],
  };
}
