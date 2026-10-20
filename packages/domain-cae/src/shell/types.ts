/** Midsurface data (05 §5.2): planar mid faces in the document frame, handed to the mesher as the geometry of a shell / plane-stress part. */

import type { Vec3 } from '@core/model/vectors';

/** One planar face of a midsurface. Lengths in document units, world frame; `outer` runs counter-clockwise about `normal`. */
export interface MidFace {
  readonly outer: readonly Vec3[];
  readonly holes: readonly (readonly Vec3[])[];
  /** Unit normal pointing to the TOP side of the wall (shell element normal after meshing). */
  readonly normal: Vec3;
  /** Wall thickness at this face (document units). */
  readonly thickness: number;
  /** What the face comes from, e.g. `box`, `flat f-1.1`, `bend b-2.1 strip 3/6`, `faces 0+5`. */
  readonly source: string;
}

type MidsurfaceMethod = 'box_plate' | 'sheet_metal' | 'face_pairing' | 'source_face';

export interface Midsurface {
  readonly entityId: string;
  readonly method: MidsurfaceMethod;
  readonly faces: readonly MidFace[];
  /** Distinct wall thicknesses (document units, ascending). */
  readonly thicknesses: readonly number[];
  /** Paired-area fraction (05 §5.2 step 5); 1 for the recipe fast paths. */
  readonly coverage: number;
  /** Kernel face indices neither paired nor an edge strip (face pairing only). */
  readonly unpairedFaces: readonly number[];
  readonly warnings: readonly string[];
}

export interface MidsurfaceOptions {
  /** Largest wall thickness that pairs (document units). */
  readonly maxThickness: number;
  /** Largest angle between the reversed normals of two paired planar faces, degrees. */
  readonly angularTolDeg: number;
}

export interface MidsurfaceRefusal {
  readonly code: string;
  readonly message: string;
}

export const isMidsurfaceRefusal = (value: Midsurface | MidsurfaceRefusal): value is MidsurfaceRefusal => 'code' in value;

/** Thicknesses equal within this relative tolerance are one thickness. */
const SAME_THICKNESS_REL = 1e-6;

/** Distinct values of `values` (ascending), merged within 1e-6 relative. */
export function distinctThicknesses(values: readonly number[]): number[] {
  const out: number[] = [];
  for (const value of [...values].sort((a, b) => a - b)) {
    const last = out.at(-1);
    if (last === undefined || value - last > SAME_THICKNESS_REL * Math.max(Math.abs(value), Math.abs(last))) out.push(value);
  }
  return out;
}

/** Diagonal of the axis-aligned box of `points` (a loop, not a spread: safe for large point sets); 0 for none. */
export function extentOf(points: readonly Vec3[]): number {
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (const point of points)
    for (let axis = 0; axis < 3; axis++) {
      lo[axis] = Math.min(lo[axis] ?? Infinity, point[axis] ?? 0);
      hi[axis] = Math.max(hi[axis] ?? -Infinity, point[axis] ?? 0);
    }
  return points.length === 0 ? 0 : Math.hypot(...hi.map((value, axis) => value - (lo[axis] ?? 0)));
}
