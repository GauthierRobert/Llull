/**
 * Area, volume and edge health of a large indexed mesh with typed arrays only (no per-edge objects): the measure the mesh commands report
 * before and after an operation on a million triangles. Closed means every edge is used by exactly two faces running in opposite directions.
 */

import type { MeshData } from '../../model/types';

export interface FastMeasure {
  readonly faces: number;
  readonly vertices: number;
  readonly area: number;
  /** Signed volume when the mesh is closed and consistently wound; else null. */
  readonly volume: number | null;
  /** Volume centroid when `volume` is a non-zero number; else null. */
  readonly centroid: readonly [number, number, number] | null;
  readonly closed: boolean;
  /** Faces repeating a vertex index. */
  readonly degenerateFaces: number;
  /** Edges used by exactly one face. */
  readonly boundaryEdges: number;
  /** Edges used by more than two faces. */
  readonly nonManifoldEdges: number;
  /** Edges whose two faces run in the same direction (orientation disagreement). */
  readonly inconsistentEdges: number;
}

export function fastMeasure(mesh: MeshData): FastMeasure {
  const { positions, indices } = mesh;
  const faces = Math.floor(indices.length / 3);
  const vertexCount = positions.length / 3;
  const referenced = new Uint8Array(vertexCount);
  const keys = new Float64Array(faces * 3);
  let area = 0;
  let volume = 0;
  let [cxSum, cySum, czSum] = [0, 0, 0];
  let degenerateFaces = 0;
  for (let f = 0; f < faces; f++) {
    const [a, b, c] = [indices[f * 3] as number, indices[f * 3 + 1] as number, indices[f * 3 + 2] as number];
    referenced[a] = 1;
    referenced[b] = 1;
    referenced[c] = 1;
    if (a === b || b === c || a === c) degenerateFaces++;
    const [ax, ay, az] = [positions[a * 3] as number, positions[a * 3 + 1] as number, positions[a * 3 + 2] as number];
    const [bx, by, bz] = [positions[b * 3] as number, positions[b * 3 + 1] as number, positions[b * 3 + 2] as number];
    const [cx, cy, cz] = [positions[c * 3] as number, positions[c * 3 + 1] as number, positions[c * 3 + 2] as number];
    const [ux, uy, uz, vx, vy, vz] = [bx - ax, by - ay, bz - az, cx - ax, cy - ay, cz - az];
    area += Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
    const signed = (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
    volume += signed;
    cxSum += (signed * (ax + bx + cx)) / 4;
    cySum += (signed * (ay + by + cy)) / 4;
    czSum += (signed * (az + bz + cz)) / 4;
    keys[f * 3] = (Math.min(a, b) * vertexCount + Math.max(a, b)) * 2 + (a < b ? 1 : 0);
    keys[f * 3 + 1] = (Math.min(b, c) * vertexCount + Math.max(b, c)) * 2 + (b < c ? 1 : 0);
    keys[f * 3 + 2] = (Math.min(c, a) * vertexCount + Math.max(c, a)) * 2 + (c < a ? 1 : 0);
  }
  keys.sort();
  let boundaryEdges = 0;
  let nonManifoldEdges = 0;
  let inconsistentEdges = 0;
  for (let i = 0; i < keys.length; ) {
    const edge = Math.floor((keys[i] as number) / 2);
    let end = i + 1;
    while (end < keys.length && Math.floor((keys[end] as number) / 2) === edge) end++;
    const uses = end - i;
    if (uses === 1) boundaryEdges++;
    else if (uses > 2) nonManifoldEdges++;
    else if ((keys[i] as number) % 2 === (keys[i + 1] as number) % 2) inconsistentEdges++;
    i = end;
  }
  let vertices = 0;
  for (const used of referenced) vertices += used;
  const closed = faces > 0 && degenerateFaces === 0 && boundaryEdges === 0 && nonManifoldEdges === 0;
  const measured = closed && inconsistentEdges === 0;
  return {
    faces,
    vertices,
    area,
    volume: measured ? volume : null,
    centroid: measured && volume !== 0 ? [cxSum / volume, cySum / volume, czSum / volume] : null,
    closed,
    degenerateFaces,
    boundaryEdges,
    nonManifoldEdges,
    inconsistentEdges,
  };
}
