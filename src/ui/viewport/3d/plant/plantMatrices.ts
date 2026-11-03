// Pure instance-matrix maths of the plant batch renderer: entity placement (Euler XYZ, as three's Object3D) as a column-major 4x4,
// optionally composed with a local bounding box (LOD2: the unit box scaled onto the prototype's box).

import type { Vec3 } from '@core/model/types';

export interface LocalBox {
  readonly min: Vec3;
  readonly max: Vec3;
}

export interface Placement {
  readonly position: Vec3;
  readonly rotation: Vec3;
}

/**
 * Writes the matrix of `placement` (translation * Rx Ry Rz) at `offset` of `out`; with `box`, the placement is composed with
 * translate(box centre) * scale(box size), i.e. maps the unit cube [-0.5, 0.5]^3 onto the entity's local box.
 */
function writePlacementMatrix(out: Float32Array, offset: number, placement: Placement, box?: LocalBox): void {
  const [rx, ry, rz] = placement.rotation;
  const a = Math.cos(rx);
  const b = Math.sin(rx);
  const c = Math.cos(ry);
  const d = Math.sin(ry);
  const e = Math.cos(rz);
  const f = Math.sin(rz);
  const ae = a * e;
  const af = a * f;
  const be = b * e;
  const bf = b * f;
  // Rotation columns (column-major).
  const x: Vec3 = [c * e, af + be * d, bf - ae * d];
  const y: Vec3 = [-c * f, ae - bf * d, be + af * d];
  const z: Vec3 = [d, -b * c, a * c];
  const [px, py, pz] = placement.position;
  let sx = 1;
  let sy = 1;
  let sz = 1;
  let tx = px;
  let ty = py;
  let tz = pz;
  if (box !== undefined) {
    sx = box.max[0] - box.min[0];
    sy = box.max[1] - box.min[1];
    sz = box.max[2] - box.min[2];
    const cx = (box.max[0] + box.min[0]) / 2;
    const cy = (box.max[1] + box.min[1]) / 2;
    const cz = (box.max[2] + box.min[2]) / 2;
    tx += x[0] * cx + y[0] * cy + z[0] * cz;
    ty += x[1] * cx + y[1] * cy + z[1] * cz;
    tz += x[2] * cx + y[2] * cy + z[2] * cz;
  }
  out.set(
    [x[0] * sx, x[1] * sx, x[2] * sx, 0, y[0] * sy, y[1] * sy, y[2] * sy, 0, z[0] * sz, z[1] * sz, z[2] * sz, 0, tx, ty, tz, 1],
    offset,
  );
}

/** Matrices of `placements` (16 floats each); `boxes[i]` (when given) scales instance i onto its local box. */
export function bucketMatrices(placements: readonly Placement[], boxes?: readonly (LocalBox | undefined)[]): Float32Array {
  const out = new Float32Array(placements.length * 16);
  placements.forEach((placement, index) => writePlacementMatrix(out, index * 16, placement, boxes?.[index]));
  return out;
}
