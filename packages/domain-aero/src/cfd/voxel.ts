/**
 * Parity ray casting of a closed surface along +X, one ray per cell row of a grid aligned with the bounds minimum (TECHNICAL_SPEC §5.2):
 * the voxel volume of the body (VC-CFD-10) and its frontal area for the blockage ratio (VC-CFD-12). Row centres are shifted by a fixed
 * fraction of a cell so that no ray runs exactly along a triangle edge of axis-aligned geometry.
 */

import type { Vec3 } from '@core/model/types';
import type { IndexedSurface } from './weld';

/** Rows (y, z cells) beyond which the cast is skipped. */
export const MAX_RAY_ROWS = 4_000_000;

const SHIFT_Y = 0.000123;
const SHIFT_Z = 0.000071;

interface Rows {
  readonly h: number;
  readonly crossings: Map<number, number[]>;
}

/** Crossings (x of every surface hit) per row, or null when the grid has more than MAX_RAY_ROWS rows. */
function castRows(surface: IndexedSurface, min: Vec3, max: Vec3, h: number): Rows | null {
  const ny = Math.max(1, Math.ceil((max[1] - min[1]) / h));
  const nz = Math.max(1, Math.ceil((max[2] - min[2]) / h));
  if (ny * nz > MAX_RAY_ROWS) return null;
  const crossings = new Map<number, number[]>();
  const { vertices, triangles } = surface;
  const v = (t: number, k: number, axis: number): number => vertices[(triangles[t * 3 + k] ?? 0) * 3 + axis] ?? 0;
  for (let t = 0; t < triangles.length / 3; t++) {
    const [ax, ay, az] = [v(t, 0, 0), v(t, 0, 1), v(t, 0, 2)];
    const [ux, uy, uz] = [v(t, 1, 0) - ax, v(t, 1, 1) - ay, v(t, 1, 2) - az];
    const [wx, wy, wz] = [v(t, 2, 0) - ax, v(t, 2, 1) - ay, v(t, 2, 2) - az];
    const nx = uy * wz - uz * wy;
    const ny3 = uz * wx - ux * wz;
    const nz3 = ux * wy - uy * wx;
    if (Math.abs(nx) <= 1e-14 * Math.hypot(nx, ny3, nz3)) continue;
    const ys = [ay, ay + uy, ay + wy];
    const zs = [az, az + uz, az + wz];
    const jLow = Math.max(0, Math.ceil((Math.min(...ys) - min[1]) / h - 0.5 - SHIFT_Y));
    const jHigh = Math.min(ny - 1, Math.floor((Math.max(...ys) - min[1]) / h - 0.5 - SHIFT_Y));
    const kLow = Math.max(0, Math.ceil((Math.min(...zs) - min[2]) / h - 0.5 - SHIFT_Z));
    const kHigh = Math.min(nz - 1, Math.floor((Math.max(...zs) - min[2]) / h - 0.5 - SHIFT_Z));
    for (let j = jLow; j <= jHigh; j++) {
      const py = min[1] + (j + 0.5 + SHIFT_Y) * h;
      for (let k = kLow; k <= kHigh; k++) {
        const pz = min[2] + (k + 0.5 + SHIFT_Z) * h;
        const qy = py - ay;
        const qz = pz - az;
        const s = (qy * wz - qz * wy) / nx;
        const r = (uy * qz - uz * qy) / nx;
        if (s < 0 || r < 0 || s + r > 1) continue;
        const x = ax - (ny3 * qy + nz3 * qz) / nx;
        const key = j * nz + k;
        const list = crossings.get(key);
        if (list === undefined) crossings.set(key, [x]);
        else list.push(x);
      }
    }
  }
  return { h, crossings };
}

export interface VoxelReport {
  readonly cellSizeM: number;
  /** Cell centres inside the surface. */
  readonly cells: number;
  readonly volumeM3: number;
  /** Rows with an odd number of hits (open or non-manifold surface); they are not counted. */
  readonly oddRows: number;
}

/**
 * Cells of size `h` (aligned with `min`) whose centre is inside the surface.
 * @failure more than MAX_RAY_ROWS rows -> null
 */
export function voxelise(surface: IndexedSurface, min: Vec3, max: Vec3, h: number): VoxelReport | null {
  const rows = castRows(surface, min, max, h);
  if (rows === null) return null;
  let cells = 0;
  let oddRows = 0;
  for (const hits of rows.crossings.values()) {
    if (hits.length % 2 !== 0) {
      oddRows++;
      continue;
    }
    hits.sort((a, b) => a - b);
    for (let i = 0; i + 1 < hits.length; i += 2) {
      const first = Math.ceil(((hits[i] ?? 0) - min[0]) / h - 0.5);
      const last = Math.ceil(((hits[i + 1] ?? 0) - min[0]) / h - 0.5);
      cells += Math.max(0, last - first);
    }
  }
  return { cellSizeM: h, cells, volumeM3: cells * h ** 3, oddRows };
}

/**
 * Area of the silhouette of the surface seen along +X, in the same units squared: rows hit at least once, times the cell area.
 * @invariant exact for boxes aligned with the bounds; boundary error is half the perimeter times the cell size otherwise
 * @failure more than MAX_RAY_ROWS rows -> null
 */
export function frontalArea(surface: IndexedSurface, min: Vec3, max: Vec3, cellsAlongLargest = 400): number | null {
  const h = Math.max(max[1] - min[1], max[2] - min[2]) / cellsAlongLargest;
  if (!(h > 0)) return 0;
  const rows = castRows(surface, min, max, h);
  return rows === null ? null : rows.crossings.size * h * h;
}
