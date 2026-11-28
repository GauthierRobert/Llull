// Instance matrices of array members straight from the packed table (pure): `T * Rxyz * S`, as `instanceToWorld` and three's Object3D.

import { INSTANCE_STRIDE } from '@core/model/instanceArray';
import type { Vec3 } from '@core/model/types';

/** Column-major 4x4 (16 floats) per index of `members`, written into `out` from slot 0; returns `out`. */
export function writeMemberMatrices(out: Float32Array, table: Float64Array, members: Uint32Array, scale: Vec3 = [1, 1, 1]): Float32Array {
  const [sx, sy, sz] = scale;
  members.forEach((index, slot) => {
    const at = index * INSTANCE_STRIDE;
    const a = Math.cos(table[at + 3] ?? 0);
    const b = Math.sin(table[at + 3] ?? 0);
    const c = Math.cos(table[at + 4] ?? 0);
    const d = Math.sin(table[at + 4] ?? 0);
    const e = Math.cos(table[at + 5] ?? 0);
    const f = Math.sin(table[at + 5] ?? 0);
    const ae = a * e;
    const af = a * f;
    const be = b * e;
    const bf = b * f;
    out.set(
      [
        c * e * sx,
        (af + be * d) * sx,
        (bf - ae * d) * sx,
        0,
        -c * f * sy,
        (ae - bf * d) * sy,
        (be + af * d) * sy,
        0,
        d * sz,
        -b * c * sz,
        a * c * sz,
        0,
        table[at] ?? 0,
        table[at + 1] ?? 0,
        table[at + 2] ?? 0,
        1,
      ],
      slot * 16,
    );
  });
  return out;
}
