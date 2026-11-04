/**
 * EXT_mesh_gpu_instancing data: per-instance translation / rotation / scale of one bucket (a mesh drawn N times by one glTF node), packed
 * as the extension's float accessors. Rotation is the quaternion of an intrinsic Euler XYZ rotation (M = Rx · Ry · Rz, as the model uses);
 * the instance matrix composes as T · R · S.
 */

import type { Vec3 } from '../../model/types';

export const GPU_INSTANCING_EXTENSION = 'EXT_mesh_gpu_instancing';

type Quat = readonly [number, number, number, number];

/** Hamilton product a · b of quaternions [x, y, z, w] (b applies first). */
function mulQuat([ax, ay, az, aw]: Quat, [bx, by, bz, bw]: Quat): Quat {
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

/** Quaternion [x, y, z, w] of the intrinsic Euler XYZ rotation `euler` (radians): q = qx · qy · qz. */
export function quaternionFromEulerXYZ([rx, ry, rz]: Vec3): Quat {
  const [sx, cx, sy, cy, sz, cz] = [rx, ry, rz].flatMap((angle) => [Math.sin(angle / 2), Math.cos(angle / 2)]) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  return mulQuat(mulQuat([sx, 0, 0, cx], [0, sy, 0, cy]), [0, 0, sz, cz]);
}

/** Packed accessor data of one bucket: TRANSLATION always, ROTATION / SCALE only when some instance is not the identity there. */
export interface PackedInstances {
  readonly count: number;
  readonly TRANSLATION: Float32Array;
  readonly ROTATION?: Float32Array;
  readonly SCALE?: Float32Array;
}

/** Collects the instances of one bucket in order. */
export class InstanceTransforms {
  private readonly translation: number[] = [];
  private readonly rotation: number[] = [];
  private readonly scale: number[] = [];
  private rotated = false;
  private scaled = false;

  get count(): number {
    return this.translation.length / 3;
  }

  add(position: Vec3, euler: Vec3, scale?: Vec3): void {
    this.translation.push(position[0], position[1], position[2]);
    const isIdentityRotation = euler[0] === 0 && euler[1] === 0 && euler[2] === 0;
    this.rotation.push(...(isIdentityRotation ? [0, 0, 0, 1] : quaternionFromEulerXYZ(euler)));
    this.rotated ||= !isIdentityRotation;
    const [sx, sy, sz] = scale ?? [1, 1, 1];
    this.scale.push(sx, sy, sz);
    this.scaled ||= sx !== 1 || sy !== 1 || sz !== 1;
  }

  packed(): PackedInstances {
    return {
      count: this.count,
      TRANSLATION: Float32Array.from(this.translation),
      ...(this.rotated ? { ROTATION: Float32Array.from(this.rotation) } : {}),
      ...(this.scaled ? { SCALE: Float32Array.from(this.scale) } : {}),
    };
  }
}
