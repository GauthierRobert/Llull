/**
 * Per-face colours of a mesh solid (`MeshSolidEntity.faceColors`, `set_face_color`). A face is the smooth patch of the mesh around a
 * picked point: the triangle closest to the point, grown across shared edges whose dihedral angle stays below FACE_CREASE_ANGLE (the
 * viewport's crease angle, so a face is what the viewport draws as one smooth surface). Exact-kernel meshes keep separate vertices per
 * B-rep face, so there a patch never leaves its B-rep face; welded meshes (Manifold, imports) stop at creases.
 */

import type { FaceColor, MeshData, Vec3 } from '../model/types';
import { closestPointOnTriangle, type Triangle } from './triangleQueries';
import { cross3, distanceSq3, dot3, len3, normalize3OrZero, sub3 } from '../lib/vec3';
import { toRadians } from '../lib/angle';

const FACE_CREASE_COS = Math.cos(toRadians(30));

interface IndexedTriangles {
  readonly count: number;
  readonly corner: (triangle: number, k: number) => number;
  readonly vertex: (index: number) => Vec3;
}

function indexedTriangles(mesh: MeshData): IndexedTriangles {
  const p = mesh.positions;
  const vertex = (i: number): Vec3 => [p[i * 3] ?? 0, p[i * 3 + 1] ?? 0, p[i * 3 + 2] ?? 0];
  if (mesh.indices.length > 0)
    return { count: Math.floor(mesh.indices.length / 3), corner: (t, k) => mesh.indices[t * 3 + k] ?? 0, vertex };
  return { count: Math.floor(p.length / 9), corner: (t, k) => t * 3 + k, vertex };
}

const triangleAt = (tris: IndexedTriangles, t: number): Triangle => [
  tris.vertex(tris.corner(t, 0)),
  tris.vertex(tris.corner(t, 1)),
  tris.vertex(tris.corner(t, 2)),
];

/** Unit normal of each triangle ([0,0,0] when degenerate). */
function triangleNormals(tris: IndexedTriangles): Vec3[] {
  const normals: Vec3[] = [];
  for (let t = 0; t < tris.count; t++) {
    const [a, b, c] = triangleAt(tris, t);
    normals.push(normalize3OrZero(cross3(sub3(b, a), sub3(c, a))));
  }
  return normals;
}

/** Triangles sharing each edge, keyed by vertex identity (index when indexed, else rounded position). */
function edgeNeighbours(tris: IndexedTriangles, indexed: boolean): number[][] {
  const key = (i: number): string =>
    indexed
      ? String(i)
      : tris
          .vertex(i)
          .map((x) => Math.round(x * 1e6))
          .join(',');
  const byEdge = new Map<string, number[]>();
  for (let t = 0; t < tris.count; t++)
    for (let k = 0; k < 3; k++) {
      const a = key(tris.corner(t, k));
      const b = key(tris.corner(t, (k + 1) % 3));
      const edge = a < b ? `${a}|${b}` : `${b}|${a}`;
      const list = byEdge.get(edge);
      if (list === undefined) byEdge.set(edge, [t]);
      else list.push(t);
    }
  const neighbours: number[][] = Array.from({ length: tris.count }, () => []);
  for (const list of byEdge.values()) for (const t of list) for (const u of list) if (t !== u) neighbours[t]?.push(u);
  return neighbours;
}

/** The smooth patches of one mesh: closest triangle to a point and the patch grown from it. */
interface MeshFaces {
  /** Closest triangle to `point` and its distance (-1 / Infinity on an empty mesh). */
  readonly closest: (point: Vec3) => { readonly triangle: number; readonly distance: number };
  /** Triangles of the smooth patch containing `seed`. */
  readonly patch: (seed: number) => ReadonlySet<number>;
}

function meshFaces(mesh: MeshData): MeshFaces {
  const tris = indexedTriangles(mesh);
  const normals = triangleNormals(tris);
  const neighbours = edgeNeighbours(tris, mesh.indices.length > 0);
  const closest = (point: Vec3): { triangle: number; distance: number } => {
    let triangle = -1;
    let best = Infinity;
    for (let t = 0; t < tris.count; t++) {
      const distance = distanceSq3(closestPointOnTriangle(point, triangleAt(tris, t)), point);
      if (distance < best) [triangle, best] = [t, distance];
    }
    return { triangle, distance: Math.sqrt(best) };
  };
  const patch = (seed: number): Set<number> => {
    const reached = new Set(seed < 0 ? [] : [seed]);
    const queue = [...reached];
    for (let next = queue.pop(); next !== undefined; next = queue.pop()) {
      const normal = normals[next] ?? [0, 0, 0];
      for (const other of neighbours[next] ?? []) {
        if (reached.has(other)) continue;
        const otherNormal = normals[other] ?? [0, 0, 0];
        const degenerate = len3(normal) === 0 || len3(otherNormal) === 0;
        if (!degenerate && dot3(normal, otherNormal) < FACE_CREASE_COS) continue;
        reached.add(other);
        queue.push(other);
      }
    }
    return reached;
  };
  return { closest, patch };
}

/**
 * The colour of every triangle of `mesh` (in index order) set by `faceColors`, undefined where none applies; a later entry wins where two
 * patches overlap. `near` points are in the mesh's own frame.
 * @pure
 */
export function faceColorTriangles(mesh: MeshData, faceColors: readonly FaceColor[]): (string | undefined)[] {
  const colors: (string | undefined)[] = Array.from({ length: indexedTriangles(mesh).count }, () => undefined);
  if (faceColors.length === 0) return colors;
  const faces = meshFaces(mesh);
  for (const { near, color } of faceColors) for (const t of faces.patch(faces.closest(near).triangle)) colors[t] = color;
  return colors;
}

/** Outcome of `mergeFaceColors`: the new list, and the picks farther than the tolerance from the mesh (ignored). */
interface FaceColorMerge {
  readonly faceColors: FaceColor[];
  readonly applied: Vec3[];
  readonly missed: Vec3[];
}

/**
 * `existing` with the faces at `picks` (mesh frame) set to `color`, or reset when `color` is undefined: an existing entry whose point
 * lies on a picked face is replaced, so recolouring a face never stacks entries. Picks farther than `tolerance` from the mesh are missed.
 * @pure
 */
export function mergeFaceColors(
  mesh: MeshData,
  existing: readonly FaceColor[],
  picks: readonly Vec3[],
  color: string | undefined,
  tolerance: number,
): FaceColorMerge {
  const faces = meshFaces(mesh);
  const applied: Vec3[] = [];
  const missed: Vec3[] = [];
  const covered = new Set<number>();
  for (const near of picks) {
    const { triangle, distance } = faces.closest(near);
    if (triangle < 0 || distance > tolerance) missed.push(near);
    else {
      applied.push(near);
      for (const t of faces.patch(triangle)) covered.add(t);
    }
  }
  const kept = existing.filter((entry) => !covered.has(faces.closest(entry.near).triangle));
  return { faceColors: color === undefined ? kept : [...kept, ...applied.map((near) => ({ near, color }))], applied, missed };
}
