/**
 * Indexed glTF vertex data of a triangle soup: corners that share a welded position, a creased normal (and a UV when present) become one
 * vertex, so a smooth surface stores each vertex once plus a u16 / u32 index buffer instead of three float corners per triangle.
 * Also the placement matrix and content hash used to share one mesh between parts with identical local geometry (pattern copies).
 */

import type { Vec3 } from '../../model/types';
import type { Triangle } from '../../geometry/triangles';
import { applyEulerXYZ } from '../../lib/eulerRotation';
import { ORIGIN } from '../../lib/vec3';

/** Positions closer than 1e-5 units weld (the crease-normal grid); normals / UVs weld on 1e-4 / 1e-5. */
const POSITION_GRID = 1e5;
const NORMAL_GRID = 1e4;
const UV_GRID = 1e5;

/** Welding key of a position (shared by the crease-normal pass). */
export function positionKey(v: Vec3): string {
  return `${Math.round(v[0] * POSITION_GRID)},${Math.round(v[1] * POSITION_GRID)},${Math.round(v[2] * POSITION_GRID)}`;
}

interface IndexedMesh {
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly uvs?: Float32Array;
  readonly indices: Uint16Array | Uint32Array;
}

/** Index buffer of the smallest glTF component type that holds `vertexCount` vertices. */
function indexArray(values: readonly number[], vertexCount: number): Uint16Array | Uint32Array {
  return vertexCount <= 0xffff ? Uint16Array.from(values) : Uint32Array.from(values);
}

/**
 * Weld a triangle soup with per-corner `normals` (3 floats per corner) and optional `uvs` (2 per corner) into indexed vertex data.
 * @invariant every triangle keeps its corner order (winding) and each corner keeps its normal / uv within the weld grid
 */
export function indexedMesh(tris: readonly Triangle[], normals: Float32Array, uvs?: Float32Array): IndexedMesh {
  const vertexOf = new Map<string, number>();
  const positions: number[] = [];
  const outNormals: number[] = [];
  const outUvs: number[] = [];
  const indices: number[] = [];
  tris.forEach((tri, face) =>
    tri.forEach((v, corner) => {
      const c = face * 3 + corner;
      const [nx, ny, nz] = [normals[c * 3] ?? 0, normals[c * 3 + 1] ?? 0, normals[c * 3 + 2] ?? 0];
      let key = `${positionKey(v)}|${Math.round(nx * NORMAL_GRID)},${Math.round(ny * NORMAL_GRID)},${Math.round(nz * NORMAL_GRID)}`;
      const [u, w] = uvs === undefined ? [0, 0] : [uvs[c * 2] ?? 0, uvs[c * 2 + 1] ?? 0];
      if (uvs !== undefined) key += `|${Math.round(u * UV_GRID)},${Math.round(w * UV_GRID)}`;
      let index = vertexOf.get(key);
      if (index === undefined) {
        index = positions.length / 3;
        vertexOf.set(key, index);
        positions.push(v[0], v[1], v[2]);
        outNormals.push(nx, ny, nz);
        if (uvs !== undefined) outUvs.push(u, w);
      }
      indices.push(index);
    }),
  );
  const vertexCount = positions.length / 3;
  const mesh = {
    positions: Float32Array.from(positions),
    normals: Float32Array.from(outNormals),
    indices: indexArray(indices, vertexCount),
  };
  return uvs === undefined ? mesh : { ...mesh, uvs: Float32Array.from(outUvs) };
}

/** Flat float32 corner positions of a triangle soup (the content compared for mesh sharing). */
function cornerPositions(tris: readonly Triangle[]): Float32Array {
  const out = new Float32Array(tris.length * 9);
  tris.forEach((tri, t) => tri.forEach((v, k) => out.set(v, t * 9 + k * 3)));
  return out;
}

/** FNV-1a hash of the float bits of `data` (a mesh-sharing bucket key; equal content is still compared). */
function contentHash(data: Float32Array): number {
  const words = new Uint32Array(data.buffer, data.byteOffset, data.length);
  let hash = 0x811c9dc5;
  for (const word of words) hash = Math.imul(hash ^ word, 0x01000193) >>> 0;
  return hash;
}

function sameContent(a: Float32Array, b: Float32Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Column-major glTF node matrix of an entity placement (Euler XYZ `rotation` about the origin, then `position`); null for identity. */
export function placementMatrix(position: Vec3, rotation: Vec3): number[] | null {
  if (position.every((c) => c === 0) && rotation.every((c) => c === 0)) return null;
  const axis = (v: Vec3): number[] => [...applyEulerXYZ(v, ORIGIN, rotation), 0];
  return [...axis([1, 0, 0]), ...axis([0, 1, 0]), ...axis([0, 0, 1]), position[0], position[1], position[2], 1];
}

/** A scene part as the mesh-sharing pass sees it: local-frame triangles, an appearance key, and whether it has a placement. */
interface ShareCandidate {
  readonly localTris: readonly Triangle[];
  readonly key: string;
  readonly placed: boolean;
}

/**
 * Mesh-sharing groups: parts with the same appearance key and bit-identical local triangles (pattern copies, repeated library parts) get
 * the same group number; a part whose geometry is unique (or that has no placement) gets undefined and keeps its own world-space mesh.
 */
export function sharedGeometryGroups(items: readonly ShareCandidate[]): (number | undefined)[] {
  const buckets = new Map<string, { content: Float32Array; members: number[] }[]>();
  items.forEach((item, index) => {
    if (!item.placed || item.localTris.length === 0) return;
    const content = cornerPositions(item.localTris);
    const bucketKey = `${item.key}#${content.length}#${contentHash(content)}`;
    const candidates = buckets.get(bucketKey) ?? [];
    const match = candidates.find((candidate) => sameContent(candidate.content, content));
    if (match !== undefined) match.members.push(index);
    else buckets.set(bucketKey, [...candidates, { content, members: [index] }]);
  });
  const groups: (number | undefined)[] = items.map(() => undefined);
  let next = 0;
  for (const candidates of buckets.values())
    for (const { members } of candidates) {
      if (members.length < 2) continue;
      for (const member of members) groups[member] = next;
      next++;
    }
  return groups;
}
