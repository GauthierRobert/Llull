import type { FrameElement, FramePoint } from './types';

/** Prepared element: geometry, local axes (rows x, y, z of the rotation) and stiffness in local and global axes. */
export interface PreparedElement {
  readonly length: number;
  /** Row-major 3x3 rotation, global -> local. */
  readonly rotation: Float64Array;
  readonly local: Float64Array;
  readonly global: Float64Array;
}

/** 12x12 local stiffness (row-major) of a straight 3D Timoshenko beam; bending EI is divided by the bend flexibility factor. */
export function localStiffness(element: FrameElement, length: number): Float64Array {
  const { youngs: E, shear: G, area: A, inertia, torsion: J, shearArea } = element.properties;
  const I = inertia / (element.flexibility ?? 1);
  const phi = shearArea > 0 ? (12 * E * I) / (G * shearArea * length * length) : 0;
  const k = new Float64Array(144);
  const set = (r: number, c: number, v: number): void => {
    k[r * 12 + c] = v;
    k[c * 12 + r] = v;
  };
  const axial = (E * A) / length;
  set(0, 0, axial);
  set(6, 6, axial);
  set(0, 6, -axial);
  const twist = (G * J) / length;
  set(3, 3, twist);
  set(9, 9, twist);
  set(3, 9, -twist);
  const c = (E * I) / (1 + phi);
  const L = length;
  // [translation dof, rotation dof, sign]: bending in local xy (rz) and xz (ry).
  for (const [v, r, s] of [
    [1, 5, 1],
    [2, 4, -1],
  ] as const) {
    set(v, v, (12 * c) / L ** 3);
    set(v + 6, v + 6, (12 * c) / L ** 3);
    set(v, v + 6, (-12 * c) / L ** 3);
    set(v, r, (s * 6 * c) / L ** 2);
    set(v, r + 6, (s * 6 * c) / L ** 2);
    set(v + 6, r, (-s * 6 * c) / L ** 2);
    set(v + 6, r + 6, (-s * 6 * c) / L ** 2);
    set(r, r, ((4 + phi) * c) / L);
    set(r + 6, r + 6, ((4 + phi) * c) / L);
    set(r, r + 6, ((2 - phi) * c) / L);
  }
  return k;
}

function cross(a: FramePoint, b: FramePoint): FramePoint {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function unit(v: FramePoint): FramePoint | null {
  const n = Math.hypot(v[0], v[1], v[2]);
  return n > 0 ? [v[0] / n, v[1] / n, v[2] / n] : null;
}

/** Local axes [x, y, z] for an element between two points; null for zero length. */
export function localAxes(p: FramePoint, q: FramePoint, up?: FramePoint): { length: number; rotation: Float64Array } | null {
  const delta: FramePoint = [q[0] - p[0], q[1] - p[1], q[2] - p[2]];
  const length = Math.hypot(delta[0], delta[1], delta[2]);
  const x = unit(delta);
  if (!x || !(length > 0)) return null;
  const preferred = up ? unit(up) : null;
  let reference: FramePoint = preferred ?? [0, 0, 1];
  const parallel = (r: FramePoint): number => Math.abs(r[0] * x[0] + r[1] * x[1] + r[2] * x[2]);
  if (parallel(reference) > 0.99) reference = parallel([0, 0, 1]) < 0.99 ? [0, 0, 1] : [1, 0, 0];
  const y = unit(cross(reference, x));
  if (!y) return null;
  const z = cross(x, y);
  return { length, rotation: Float64Array.from([...x, ...y, ...z]) };
}

/** Global stiffness Tt k T assembled blockwise from the 3x3 rotation. */
export function globalStiffness(local: Float64Array, rotation: Float64Array): Float64Array {
  const out = new Float64Array(144);
  const tmp = new Float64Array(9);
  for (let bi = 0; bi < 4; bi++) {
    for (let bj = 0; bj < 4; bj++) {
      // tmp = block(local) * R ; out_block = R^T * tmp
      for (let r = 0; r < 3; r++) {
        for (let c = 0; c < 3; c++) {
          let sum = 0;
          for (let m = 0; m < 3; m++) sum += (local[(bi * 3 + r) * 12 + bj * 3 + m] as number) * (rotation[m * 3 + c] as number);
          tmp[r * 3 + c] = sum;
        }
      }
      for (let r = 0; r < 3; r++) {
        for (let c = 0; c < 3; c++) {
          let sum = 0;
          for (let m = 0; m < 3; m++) sum += (rotation[m * 3 + r] as number) * (tmp[m * 3 + c] as number);
          out[(bi * 3 + r) * 12 + bj * 3 + c] = sum;
        }
      }
    }
  }
  return out;
}

/** Local equivalent nodal load vector of a uniform global load and a free axial strain. */
export function equivalentLoad(
  element: FrameElement,
  prepared: PreparedElement,
  uniform: FramePoint | undefined,
  freeStrain: number,
): Float64Array {
  const fe = new Float64Array(12);
  const { length: L, rotation: R } = prepared;
  if (freeStrain !== 0) {
    const force = element.properties.youngs * element.properties.area * freeStrain;
    fe[0] = (fe[0] as number) - force;
    fe[6] = (fe[6] as number) + force;
  }
  if (uniform) {
    const q = [0, 1, 2].map(
      (row) => (R[row * 3] as number) * uniform[0] + (R[row * 3 + 1] as number) * uniform[1] + (R[row * 3 + 2] as number) * uniform[2],
    );
    const qx = q[0] as number;
    fe[0] = (fe[0] as number) + (qx * L) / 2;
    fe[6] = (fe[6] as number) + (qx * L) / 2;
    for (const [d, m1, m2, s] of [
      [1, 5, 11, 1],
      [2, 4, 10, -1],
    ] as const) {
      const qd = q[d] as number;
      fe[d] = (fe[d] as number) + (qd * L) / 2;
      fe[d + 6] = (fe[d + 6] as number) + (qd * L) / 2;
      fe[m1] = (fe[m1] as number) + (s * qd * L * L) / 12;
      fe[m2] = (fe[m2] as number) - (s * qd * L * L) / 12;
    }
  }
  return fe;
}

/** Rotates a 12-vector global -> local (blockwise). */
export function toLocal(rotation: Float64Array, global: ArrayLike<number>): Float64Array {
  const out = new Float64Array(12);
  for (let block = 0; block < 4; block++) {
    for (let r = 0; r < 3; r++) {
      let sum = 0;
      for (let c = 0; c < 3; c++) sum += (rotation[r * 3 + c] as number) * (global[block * 3 + c] as number);
      out[block * 3 + r] = sum;
    }
  }
  return out;
}

/** Rotates a 12-vector local -> global (blockwise). */
export function toGlobal(rotation: Float64Array, local: ArrayLike<number>): Float64Array {
  const out = new Float64Array(12);
  for (let block = 0; block < 4; block++) {
    for (let c = 0; c < 3; c++) {
      let sum = 0;
      for (let r = 0; r < 3; r++) sum += (rotation[r * 3 + c] as number) * (local[block * 3 + r] as number);
      out[block * 3 + c] = sum;
    }
  }
  return out;
}
