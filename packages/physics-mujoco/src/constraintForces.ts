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

/** A Jacobian column is numerically dependent on the others below this fraction of the largest column norm. */
const RANK_TOLERANCE = 1e-6;

/**
 * Orthonormal basis of the span of `count` columns of `length` values stored one after the other in `residual` (pivoted Gram-Schmidt, rank
 * decided at RANK_TOLERANCE of the largest norm). `residual` is consumed; the basis vectors are written at the front of `basis` and their
 * number returned. Flat typed arrays: a loop mechanism reads its reactions every step, and the sums run in the same order as on rows of
 * plain arrays, so the result is the same to the last bit.
 */
function orthonormalBasis(residual: Float64Array, count: number, length: number, basis: Float64Array): number {
  let rank = 0;
  let largest = 0;
  for (;;) {
    let best = -1;
    let bestNorm = 0;
    for (let column = 0; column < count; column++) {
      let sum = 0;
      for (let k = column * length; k < (column + 1) * length; k++) sum += (residual[k] as number) * (residual[k] as number);
      const norm = Math.sqrt(sum);
      if (norm > bestNorm) [best, bestNorm] = [column, norm];
    }
    largest = Math.max(largest, bestNorm);
    if (best < 0 || bestNorm <= RANK_TOLERANCE * largest) return rank;
    const unit = rank * length;
    for (let k = 0; k < length; k++) basis[unit + k] = (residual[best * length + k] as number) / bestNorm;
    rank += 1;
    for (let column = 0; column < count; column++) {
      const at = column * length;
      let along = 0;
      for (let k = 0; k < length; k++) along += (residual[at + k] as number) * (basis[unit + k] as number);
      for (let k = 0; k < length; k++) residual[at + k] = (residual[at + k] as number) - along * (basis[unit + k] as number);
    }
  }
}

export interface LoopReader {
  /**
   * Remove the part of the loop-constraint multipliers that produces no generalised force (J^T lambda = 0: rows made redundant by the tree
   * joints, e.g. the out-of-plane row of a planar loop with a spherical wrist). Those multipliers are indeterminate, so the solver's value
   * is numerical noise that would show up as spurious reactions; the kept part is the minimum-norm lambda with the same dynamics.
   * Call after `mj_forward`, before `mj_rnePostConstraint`.
   */
  dropRedundantForces(model: MjModel, data: MjData): void;
  /** Force each loop exerts on its bodyB, N (call after `mj_forward`). */
  forces(data: MjData): Vec3[];
  /** Largest |constraint violation| over the loops' rows now, m. */
  residual(data: MjData): number;
}

export function loopReader(slots: readonly LoopSlot[]): LoopReader {
  const owner = equalityOwners(slots);
  // Work arrays of `dropRedundantForces`, kept between calls (grown when the constraint rows outgrow them).
  let columns = new Float64Array(0);
  let basis = new Float64Array(0);
  return {
    dropRedundantForces(model, data) {
      const [types, ids, force, jacobian] = [data.efc_type, data.efc_id, data.efc_force, data.efc_J];
      const rows: number[] = [];
      for (let row = 0; row < data.nefc; row++) if (types[row] === CONSTRAINT_EQUALITY && owner.has(ids[row] ?? -1)) rows.push(row);
      if (rows.length === 0) return;
      const nv = model.nv;
      const length = rows.length;
      if (columns.length < nv * length) {
        columns = new Float64Array(nv * length);
        basis = new Float64Array(nv * length);
      }
      for (let v = 0; v < nv; v++) for (let k = 0; k < length; k++) columns[v * length + k] = jacobian[(rows[k] as number) * nv + v] ?? 0;
      const lambda = rows.map((row) => force[row] ?? 0);
      const kept = new Float64Array(length);
      const rank = orthonormalBasis(columns, nv, length, basis);
      for (let unit = 0; unit < rank; unit++) {
        let along = 0;
        for (let k = 0; k < length; k++) along += (basis[unit * length + k] as number) * (lambda[k] as number);
        for (let k = 0; k < length; k++) kept[k] = (kept[k] as number) + along * (basis[unit * length + k] as number);
      }
      rows.forEach((row, k) => (force[row] = kept[k] as number));
    },
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
