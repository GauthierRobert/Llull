/**
 * Body pose and twist for the load callbacks (TR-FLT-01): a kinematics pass (mj_kinematics + mj_comPos + mj_comVel, no dynamics) of the current
 * state, read per body, and the step-midpoint extrapolation the engine gives `loads` (the same rule as the joint state).
 */

import type { BodyKinematics } from '@core/dynamics/physicsEngine';
import type { Quaternion, Vec3 } from '@core/model/vectors';
import type { MjData, MjModel, MujocoModule } from './bindings';

interface BodySlot {
  readonly id: string;
  readonly index: number;
}

export interface BodyStateReader {
  /** Kinematics of the current state half a step ahead (the step midpoint); remembers the current velocities for the next call. */
  midpoint(timestep: number): Record<string, BodyKinematics>;
  /** Current velocities after a kinematics pass (also refreshes xpos / xquat for the sample). */
  sample(): Record<string, { linear: Vec3; angular: Vec3 }>;
}

const vec3At = (values: Float64Array, offset: number): Vec3 => [values[offset] ?? 0, values[offset + 1] ?? 0, values[offset + 2] ?? 0];

/** Quaternion product a · b ([w, x, y, z]). */
function multiply(a: Quaternion, b: Quaternion): Quaternion {
  const [aw, ax, ay, az] = a;
  const [bw, bx, by, bz] = b;
  return [
    aw * bw - ax * bx - ay * by - az * bz,
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
  ];
}

const conjugate = (q: Quaternion): Quaternion => [q[0], -q[1], -q[2], -q[3]];

/** Rotation by angle |w|·t about w (world angular velocity w over time t), as a unit quaternion. */
function rotationOver(w: Vec3, t: number): Quaternion {
  const rate = Math.hypot(w[0], w[1], w[2]);
  if (!(rate > 0)) return [1, 0, 0, 0];
  const half = 0.5 * rate * t;
  const s = Math.sin(half) / rate;
  return [Math.cos(half), w[0] * s, w[1] * s, w[2] * s];
}

const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** Reader of `ids` (the model's `bodyStates`), or null when there are none (the engine then does no extra pass). */
export function createBodyStateReader(
  mujoco: MujocoModule,
  model: MjModel,
  data: MjData,
  slots: readonly BodySlot[],
  initialOrientation: ReadonlyMap<string, Quaternion>,
): BodyStateReader | null {
  if (slots.length === 0) return null;
  let previous: Map<string, { linear: Vec3; angular: Vec3 }> | null = null;
  const read = (): { slot: BodySlot; position: Vec3; orientation: Quaternion; linear: Vec3; angular: Vec3 }[] => {
    mujoco.mj_kinematics(model, data);
    mujoco.mj_comPos(model, data);
    mujoco.mj_comVel(model, data);
    return slots.map((slot) => {
      const i = slot.index;
      const position = vec3At(data.xpos, 3 * i);
      const q = data.xquat;
      const world: Quaternion = [q[4 * i] ?? 1, q[4 * i + 1] ?? 0, q[4 * i + 2] ?? 0, q[4 * i + 3] ?? 0];
      const orientation = multiply(world, conjugate(initialOrientation.get(slot.id) ?? [1, 0, 0, 0]));
      // cvel = [angular; linear at the subtree centre of mass of the body's root], world axes
      const angular = vec3At(data.cvel, 6 * i);
      const atRoot = vec3At(data.cvel, 6 * i + 3);
      const root = vec3At(data.subtree_com, 3 * (model.body_rootid[i] ?? 0));
      const arm: Vec3 = [position[0] - root[0], position[1] - root[1], position[2] - root[2]];
      const spin = cross(angular, arm);
      return { slot, position, orientation, angular, linear: [atRoot[0] + spin[0], atRoot[1] + spin[1], atRoot[2] + spin[2]] };
    });
  };
  return {
    midpoint: (timestep) => {
      const now = read();
      const last = previous;
      previous = new Map(now.map((entry) => [entry.slot.id, { linear: entry.linear, angular: entry.angular }]));
      const ahead = (value: Vec3, before: Vec3 | undefined): Vec3 => {
        const from = before ?? value;
        return [value[0] + 0.5 * (value[0] - from[0]), value[1] + 0.5 * (value[1] - from[1]), value[2] + 0.5 * (value[2] - from[2])];
      };
      return Object.fromEntries(
        now.map(({ slot, position, orientation, linear, angular }) => {
          const before = last?.get(slot.id);
          const h = 0.5 * timestep;
          const kinematics: BodyKinematics = {
            position: [position[0] + h * linear[0], position[1] + h * linear[1], position[2] + h * linear[2]],
            orientation: multiply(rotationOver(angular, h), orientation),
            linearVelocity: ahead(linear, before?.linear),
            angularVelocity: ahead(angular, before?.angular),
          };
          return [slot.id, kinematics];
        }),
      );
    },
    sample: () => Object.fromEntries(read().map(({ slot, linear, angular }) => [slot.id, { linear, angular }])),
  };
}
