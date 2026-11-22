/**
 * Oriented bounding boxes of display meshes and their separating-axis test (broad phase step 2, TR-ASC-07).
 * @invariant the box encloses every MESH vertex (extents are projected, not fitted); a curved solid sticks out of its tessellation by the chord bound,
 *   so callers pass `margin` grown by it (`broadPhase`)
 * @invariant deterministic: fixed Jacobi sweeps, no random
 */

import type { MeshData, Vec3 } from '../../model/types';
import { cross3, dot3, len3 } from '../../lib/vec3';

export interface Obb {
  readonly center: Vec3;
  /** Orthonormal axes. */
  readonly axes: readonly [Vec3, Vec3, Vec3];
  readonly half: Vec3;
}

const num = (values: ArrayLike<number>, index: number): number => values[index] as number;
const at = (m: number[][], i: number, j: number): number => num(m[i] as number[], j);
const JACOBI_SWEEPS = 16;
const SEPARATION_EPS = 1e-9;

/** Eigenvectors (columns of the returned axes) of a symmetric 3x3 by cyclic Jacobi rotations. */
function eigenAxes(cov: number[][]): [Vec3, Vec3, Vec3] {
  const a = cov.map((row) => [...row]);
  const v = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  for (let sweep = 0; sweep < JACOBI_SWEEPS; sweep++) {
    for (const [p, q] of [
      [0, 1],
      [0, 2],
      [1, 2],
    ] as const) {
      const apq = at(a, p, q);
      if (Math.abs(apq) < 1e-300) continue;
      const theta = (at(a, q, q) - at(a, p, p)) / (2 * apq);
      const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1);
      const s = t * c;
      for (let k = 0; k < 3; k++) {
        const [akp, akq] = [at(a, k, p), at(a, k, q)];
        (a[k] as number[])[p] = c * akp - s * akq;
        (a[k] as number[])[q] = s * akp + c * akq;
      }
      for (let k = 0; k < 3; k++) {
        const [apk, aqk] = [at(a, p, k), at(a, q, k)];
        (a[p] as number[])[k] = c * apk - s * aqk;
        (a[q] as number[])[k] = s * apk + c * aqk;
      }
      for (let k = 0; k < 3; k++) {
        const [vkp, vkq] = [at(v, k, p), at(v, k, q)];
        (v[k] as number[])[p] = c * vkp - s * vkq;
        (v[k] as number[])[q] = s * vkp + c * vkq;
      }
    }
  }
  return [0, 1, 2].map((col): Vec3 => [at(v, 0, col), at(v, 1, col), at(v, 2, col)]) as [Vec3, Vec3, Vec3];
}

/** The OBB of the mesh vertices, or null for an empty mesh. */
export function obbOfMesh(mesh: MeshData | null): Obb | null {
  const count = mesh === null ? 0 : Math.floor(mesh.positions.length / 3);
  if (mesh === null || count === 0) return null;
  const mean = [0, 0, 0];
  for (let i = 0; i < count; i++) for (let k = 0; k < 3; k++) mean[k] = num(mean, k) + num(mesh.positions, i * 3 + k) / count;
  const cov = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  for (let i = 0; i < count; i++) {
    const d = [0, 1, 2].map((k) => num(mesh.positions, i * 3 + k) - num(mean, k));
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) (cov[r] as number[])[c] = at(cov, r, c) + num(d, r) * num(d, c);
  }
  const axes = eigenAxes(cov);
  const low = [Infinity, Infinity, Infinity];
  const high = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < count; i++) {
    const point: Vec3 = [num(mesh.positions, i * 3), num(mesh.positions, i * 3 + 1), num(mesh.positions, i * 3 + 2)];
    axes.forEach((axis, k) => {
      const projected = dot3(point, axis);
      low[k] = Math.min(num(low, k), projected);
      high[k] = Math.max(num(high, k), projected);
    });
  }
  const mid = [0, 1, 2].map((k) => (num(low, k) + num(high, k)) / 2);
  const center: Vec3 = [0, 1, 2].reduce<Vec3>(
    (acc, k) => [
      acc[0] + num(mid, k) * (axes[k] as Vec3)[0],
      acc[1] + num(mid, k) * (axes[k] as Vec3)[1],
      acc[2] + num(mid, k) * (axes[k] as Vec3)[2],
    ],
    [0, 0, 0],
  );
  return { center, axes, half: [0, 1, 2].map((k) => (num(high, k) - num(low, k)) / 2) as unknown as Vec3 };
}

/** True when some axis separates the boxes by more than `margin` (then the parts are further apart than `margin`). */
export function obbsSeparated(a: Obb, b: Obb, margin: number): boolean {
  const delta: Vec3 = [b.center[0] - a.center[0], b.center[1] - a.center[1], b.center[2] - a.center[2]];
  const radius = (box: Obb, axis: Vec3): number =>
    box.axes.reduce((sum, boxAxis, k) => sum + Math.abs(dot3(boxAxis, axis)) * box.half[k as 0 | 1 | 2], 0);
  const separates = (axis: Vec3): boolean => {
    const length = len3(axis);
    if (length < 1e-9) return false;
    const unit: Vec3 = [axis[0] / length, axis[1] / length, axis[2] / length];
    return Math.abs(dot3(delta, unit)) > radius(a, unit) + radius(b, unit) + margin + SEPARATION_EPS;
  };
  for (const axis of [...a.axes, ...b.axes]) if (separates(axis)) return true;
  for (const first of a.axes) for (const second of b.axes) if (separates(cross3(first, second))) return true;
  return false;
}
