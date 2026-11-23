/**
 * Per-face colours of a mesh solid (`MeshSolidEntity.faceColors`, `set_face_color`). A face is the smooth patch of the mesh around a
 * picked point: the triangle closest to the point, grown across shared edges whose dihedral angle stays below FACE_CREASE_ANGLE (the
 * viewport's crease angle, so a face is what the viewport draws as one smooth surface). Exact-kernel meshes keep separate vertices per
 * B-rep face, so there a patch never leaves its B-rep face; welded meshes (Manifold, imports) stop at creases.
 */

import type { Entity, FaceColor, MeshData, Vec3 } from '../model/types';
import { localTriangles } from './solidTriangles';
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
    const normal = cross3(sub3(b, a), sub3(c, a));
    const longest = Math.max(len3(sub3(b, a)), len3(sub3(c, a)), len3(sub3(c, b)));
    // a sliver (pole fans, collapsed quads) has no direction: relative to its own size, not to a fixed epsilon
    normals.push(len3(normal) <= 1e-9 * longest * longest ? [0, 0, 0] : normalize3OrZero(normal));
  }
  return normals;
}

/**
 * Welded vertex ids of an unindexed mesh: corners closer than a tolerance relative to the mesh size share an id (a spatial hash that also
 * looks in the neighbouring cells, so two corners straddling a cell border still weld).
 */
function weldedIds(tris: IndexedTriangles): (i: number) => string {
  let [min, max] = [Infinity, -Infinity];
  const count = tris.count * 3;
  for (let i = 0; i < count; i++) for (const x of tris.vertex(i)) [min, max] = [Math.min(min, x), Math.max(max, x)];
  const tolerance = Math.max((max - min) * 1e-6, 1e-12);
  const cells = new Map<string, number[]>();
  const ids: number[] = [];
  const cellOf = (v: Vec3): [number, number, number] => [
    Math.floor(v[0] / tolerance),
    Math.floor(v[1] / tolerance),
    Math.floor(v[2] / tolerance),
  ];
  for (let i = 0; i < count; i++) {
    const v = tris.vertex(i);
    const [cx, cy, cz] = cellOf(v);
    let found = -1;
    for (let dx = -1; dx <= 1 && found < 0; dx++)
      for (let dy = -1; dy <= 1 && found < 0; dy++)
        for (let dz = -1; dz <= 1 && found < 0; dz++)
          for (const other of cells.get(`${cx + dx},${cy + dy},${cz + dz}`) ?? [])
            if (distanceSq3(tris.vertex(other), v) <= tolerance * tolerance) found = ids[other] as number;
    ids.push(found < 0 ? i : found);
    if (found < 0) cells.set(`${cx},${cy},${cz}`, [...(cells.get(`${cx},${cy},${cz}`) ?? []), i]);
  }
  return (i) => String(ids[i] ?? i);
}

/** Triangles sharing each edge, keyed by vertex identity (index when indexed, else welded position). */
function edgeNeighbours(tris: IndexedTriangles, indexed: boolean): number[][] {
  const key = indexed ? String : weldedIds(tris);
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
  /**
   * The mesh cut into patches in triangle order: `owner[t]` = ordinal of the patch of triangle `t`, `seeds[k]` = first triangle of patch `k`.
   * A parametric solid keeps its triangle order when it is resized, so an ordinal names the same side before and after.
   */
  readonly partition: () => { readonly owner: readonly number[]; readonly seeds: readonly number[] };
  readonly centroid: (triangle: number) => Vec3;
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
  const partition = (): { owner: number[]; seeds: number[] } => {
    const owner: number[] = Array.from({ length: tris.count }, () => -1);
    const seeds: number[] = [];
    for (let t = 0; t < tris.count; t++) {
      if (owner[t] !== -1) continue;
      for (const member of patch(t)) if (owner[member] === -1) owner[member] = seeds.length;
      seeds.push(t);
    }
    return { owner, seeds };
  };
  const centroid = (t: number): Vec3 => {
    const [a, b, c] = triangleAt(tris, t);
    return [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3];
  };
  return { closest, patch, partition, centroid };
}

/** Triangles an entry colours: its patch by ordinal (`face`, parametric solids, while the patch count is the one it was picked at) else the smooth patch around `near`. */
function entryTriangles(
  faces: MeshFaces,
  parts: () => { readonly owner: readonly number[]; readonly seeds: readonly number[] },
  entry: FaceColor,
): Iterable<number> {
  const { owner, seeds } = entry.face === undefined ? { owner: [], seeds: [] } : parts();
  if (entry.face === undefined || (entry.of !== undefined && entry.of !== seeds.length))
    return faces.patch(faces.closest(entry.near).triangle);
  return owner.flatMap((patchOf, t) => (patchOf === entry.face ? [t] : []));
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
  let parts: ReturnType<MeshFaces['partition']> | undefined;
  const partition = (): ReturnType<MeshFaces['partition']> => (parts ??= faces.partition());
  for (const entry of faceColors) for (const t of entryTriangles(faces, partition, entry)) colors[t] = entry.color;
  return colors;
}

/** Outcome of `mergeFaceColors`: the new list, the picks applied (with the patch ordinal of each) and the picks farther than the tolerance (ignored). */
interface FaceColorMerge {
  readonly faceColors: FaceColor[];
  readonly applied: Vec3[];
  readonly ordinals: number[];
  readonly missed: Vec3[];
}

/**
 * `existing` with the faces at `picks` (mesh frame) set to `color`, or reset when `color` is undefined: an existing entry on a picked face is
 * replaced, so recolouring a face never stacks entries. Picks farther than `tolerance` from the mesh are missed. With `byOrdinal` (parametric
 * solids) each new entry also stores the ordinal of its patch, which is what drawing and regeneration resolve.
 * @pure
 */
export function mergeFaceColors(
  mesh: MeshData,
  existing: readonly FaceColor[],
  picks: readonly Vec3[],
  color: string | undefined,
  tolerance: number,
  byOrdinal = false,
): FaceColorMerge {
  const faces = meshFaces(mesh);
  const { owner, seeds } = faces.partition();
  const applied: Vec3[] = [];
  const ordinals: number[] = [];
  const missed: Vec3[] = [];
  const covered = new Set<number>();
  for (const near of picks) {
    const { triangle, distance } = faces.closest(near);
    if (triangle < 0 || distance > tolerance) missed.push(near);
    else {
      applied.push(near);
      ordinals.push(owner[triangle] ?? 0);
      for (const t of byOrdinal ? owner.flatMap((o, i) => (o === owner[triangle] ? [i] : [])) : faces.patch(triangle)) covered.add(t);
    }
  }
  const seedOf = (entry: FaceColor): number =>
    entry.face === undefined || (entry.of !== undefined && entry.of !== seeds.length)
      ? faces.closest(entry.near).triangle
      : owner.findIndex((patchOf) => patchOf === entry.face);
  const kept = existing.filter((entry) => !covered.has(seedOf(entry)));
  const added = applied.map(
    (near, i): FaceColor => ({ near, color: color ?? '', ...(byOrdinal ? { face: ordinals[i] as number, of: seeds.length } : {}) }),
  );
  return { faceColors: color === undefined ? kept : [...kept, ...added], applied, ordinals, missed };
}

/** One point per patch ordinal (the centroid of its first triangle), mesh frame: what a stored ordinal is turned back into to pick that face. @pure */
export function ordinalPoints(mesh: MeshData): Vec3[] {
  const faces = meshFaces(mesh);
  return faces.partition().seeds.map(faces.centroid);
}

/** Every coloured triangle of `mesh` with its colour, in triangle order (a bake into a triangle soup re-picks each one). @pure */
export function coloredTriangles(mesh: MeshData, faceColors: readonly FaceColor[]): Array<{ triangle: number; color: string }> {
  return faceColorTriangles(mesh, faceColors).flatMap((color, triangle) => (color === undefined ? [] : [{ triangle, color }]));
}

/** Entity kinds that carry `faceColors`: mesh solids and the parametric solids whose triangles are fixed by their parameters. */
export const FACE_COLORED_KINDS: ReadonlySet<string> = new Set([
  'mesh',
  'box',
  'cylinder',
  'sphere',
  'cone',
  'torus',
  'wedge',
  'pyramid',
  'extrusion',
  'revolution',
]);

export const acceptsFaceColors = (e: Entity): boolean => FACE_COLORED_KINDS.has(e.kind);

/** The triangles `faceColors` of `e` refer to, in the entity frame and in the order of `solidTriangles`: a mesh solid's mesh, else the solid's tessellation. @pure */
export function faceColorMesh(e: Entity): MeshData {
  if (e.kind === 'mesh') return e.mesh;
  const positions: number[] = [];
  for (const triangle of localTriangles(e)) for (const [x, y, z] of triangle) positions.push(x, y, z);
  return { positions, indices: [] };
}

/** `e`'s face colours when it has any. */
export const faceColorsOf = (e: Entity): readonly FaceColor[] | undefined =>
  acceptsFaceColors(e) && 'faceColors' in e && e.faceColors !== undefined && e.faceColors.length > 0 ? e.faceColors : undefined;

/** The face colour at each of `points` (mesh frame): that of the triangle nearest to the point, undefined where none applies. @pure */
export function faceColorsAt(mesh: MeshData, faceColors: readonly FaceColor[], points: readonly Vec3[]): (string | undefined)[] {
  const colors = faceColorTriangles(mesh, faceColors);
  const faces = meshFaces(mesh);
  return points.map((point) => colors[faces.closest(point).triangle]);
}
