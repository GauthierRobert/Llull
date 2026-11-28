/** Texture coordinates and normals of a mesh (RV1 RV-M1): the stored ones when valid, else derived from the triangles. */

import type { MeshData } from '../model/types';

/** Document units one texture tile spans when UVs are projected and no `uvScale` is given (`Appearance.uvScale`). */
export const DEFAULT_UV_SCALE = 100;

/**
 * Normals, 3 per vertex.
 * @invariant stored `normals` are returned as they are when their length equals `positions`; otherwise each vertex gets the area-weighted
 *   mean of its triangles' normals, normalised (a vertex no triangle uses, or a degenerate one, gets +Z)
 */
export function meshNormals(mesh: Pick<MeshData, 'positions' | 'indices' | 'normals'>): ReadonlyArray<number> {
  const { positions, indices } = mesh;
  if (mesh.normals !== undefined && mesh.normals.length === positions.length) return mesh.normals;
  const sums = new Array<number>(positions.length).fill(0);
  const vertexCount = positions.length / 3;
  for (let t = 0; t + 2 < indices.length; t += 3) {
    const a = indices[t] as number;
    const b = indices[t + 1] as number;
    const c = indices[t + 2] as number;
    if (!(a < vertexCount && b < vertexCount && c < vertexCount)) continue;
    const ux = (positions[b * 3] as number) - (positions[a * 3] as number);
    const uy = (positions[b * 3 + 1] as number) - (positions[a * 3 + 1] as number);
    const uz = (positions[b * 3 + 2] as number) - (positions[a * 3 + 2] as number);
    const vx = (positions[c * 3] as number) - (positions[a * 3] as number);
    const vy = (positions[c * 3 + 1] as number) - (positions[a * 3 + 1] as number);
    const vz = (positions[c * 3 + 2] as number) - (positions[a * 3 + 2] as number);
    // the cross product's length is twice the triangle area: summing it unnormalised weights by area
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    for (const vertex of [a, b, c]) {
      sums[vertex * 3] = (sums[vertex * 3] as number) + nx;
      sums[vertex * 3 + 1] = (sums[vertex * 3 + 1] as number) + ny;
      sums[vertex * 3 + 2] = (sums[vertex * 3 + 2] as number) + nz;
    }
  }
  const normals = new Array<number>(positions.length);
  for (let v = 0; v < vertexCount; v++) {
    const x = sums[v * 3] as number;
    const y = sums[v * 3 + 1] as number;
    const z = sums[v * 3 + 2] as number;
    const length = Math.hypot(x, y, z);
    const usable = length > 0 && Number.isFinite(length);
    normals[v * 3] = usable ? x / length : 0;
    normals[v * 3 + 1] = usable ? y / length : 0;
    normals[v * 3 + 2] = usable ? z / length : 1;
  }
  return normals;
}

/**
 * Texture coordinates, 2 per vertex.
 * @invariant stored `uvs` are returned as they are when their length is 2 × the vertex count; otherwise a box projection: the dominant axis of
 *   the vertex normal (`meshNormals`) picks the plane (x: y,z; y: x,z; z: x,y) and the coordinates are divided by `uvScale` (document units per tile)
 * @invariant a non-positive or non-finite `uvScale` falls back to DEFAULT_UV_SCALE
 */
export function meshUvs(
  mesh: Pick<MeshData, 'positions' | 'indices' | 'normals' | 'uvs'>,
  uvScale: number = DEFAULT_UV_SCALE,
): ReadonlyArray<number> {
  const vertexCount = mesh.positions.length / 3;
  if (mesh.uvs !== undefined && mesh.uvs.length === vertexCount * 2) return mesh.uvs;
  const scale = Number.isFinite(uvScale) && uvScale > 0 ? uvScale : DEFAULT_UV_SCALE;
  const normals = meshNormals(mesh);
  const uvs = new Array<number>(vertexCount * 2);
  for (let v = 0; v < vertexCount; v++) {
    const ax = Math.abs(normals[v * 3] as number);
    const ay = Math.abs(normals[v * 3 + 1] as number);
    const az = Math.abs(normals[v * 3 + 2] as number);
    const x = mesh.positions[v * 3] as number;
    const y = mesh.positions[v * 3 + 1] as number;
    const z = mesh.positions[v * 3 + 2] as number;
    const [u, w] = ax >= ay && ax >= az ? [y, z] : ay >= az ? [x, z] : [x, y];
    uvs[v * 2] = u / scale;
    uvs[v * 2 + 1] = w / scale;
  }
  return uvs;
}
