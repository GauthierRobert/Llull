/**
 * Overhang analysis of a closed mesh for a build direction (05 IMP FR-IMP-44): the area of faces that look downward and are flatter than a critical angle.
 * @invariant a face with outward unit normal n needs support when n . up < 0 and its inclination to the build plate, acos(|n . up|), is below the critical angle
 */

import type { MeshData, Vec3 } from '@core/model/types';

export interface OverhangResult {
  /** Area of faces below the critical angle (document units squared). */
  readonly area: number;
  readonly totalArea: number;
  readonly fraction: number;
  /** Area-weighted centroid of the overhanging faces, or null when there are none. */
  readonly centroid: Vec3 | null;
  /** Lowest-inclination (flattest) overhanging face: its inclination in degrees, or null. */
  readonly flattestDeg: number | null;
  readonly triangles: number;
}

/** Overhang of `mesh` (outward oriented) for the build direction `up` (any non-zero vector pointing away from the plate) and `criticalAngleDeg` in (0, 90]. */
export function overhang(mesh: MeshData, up: Vec3, criticalAngleDeg: number): OverhangResult {
  const length = Math.hypot(...up);
  const u: Vec3 = [up[0] / length, up[1] / length, up[2] / length];
  const cosCritical = Math.cos((criticalAngleDeg * Math.PI) / 180);
  let area = 0;
  let total = 0;
  let count = 0;
  let flattest = 90;
  const weighted: [number, number, number] = [0, 0, 0];
  const p = mesh.positions;
  for (let t = 0; t + 2 < mesh.indices.length; t += 3) {
    const [ia, ib, ic] = [(mesh.indices[t] as number) * 3, (mesh.indices[t + 1] as number) * 3, (mesh.indices[t + 2] as number) * 3];
    const e1 = [
      (p[ib] as number) - (p[ia] as number),
      (p[ib + 1] as number) - (p[ia + 1] as number),
      (p[ib + 2] as number) - (p[ia + 2] as number),
    ];
    const e2 = [
      (p[ic] as number) - (p[ia] as number),
      (p[ic + 1] as number) - (p[ia + 1] as number),
      (p[ic + 2] as number) - (p[ia + 2] as number),
    ];
    const n = [
      (e1[1] as number) * (e2[2] as number) - (e1[2] as number) * (e2[1] as number),
      (e1[2] as number) * (e2[0] as number) - (e1[0] as number) * (e2[2] as number),
      (e1[0] as number) * (e2[1] as number) - (e1[1] as number) * (e2[0] as number),
    ];
    const twice = Math.hypot(n[0] as number, n[1] as number, n[2] as number);
    if (twice === 0) continue;
    const faceArea = twice / 2;
    total += faceArea;
    const along = ((n[0] as number) * u[0] + (n[1] as number) * u[1] + (n[2] as number) * u[2]) / twice;
    if (along >= 0 || -along <= cosCritical) continue;
    area += faceArea;
    count += 1;
    flattest = Math.min(flattest, (Math.acos(Math.min(1, -along)) * 180) / Math.PI);
    for (const axis of [0, 1, 2] as const)
      weighted[axis] += (faceArea * ((p[ia + axis] as number) + (p[ib + axis] as number) + (p[ic + axis] as number))) / 3;
  }
  return {
    area,
    totalArea: total,
    fraction: total === 0 ? 0 : area / total,
    centroid: area === 0 ? null : [weighted[0] / area, weighted[1] / area, weighted[2] / area],
    flattestDeg: count === 0 ? null : flattest,
    triangles: count,
  };
}
