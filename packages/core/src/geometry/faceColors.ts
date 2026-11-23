/**
 * Per-face colours of a mesh solid (`MeshSolidEntity.faceColors`, `set_face_color`). A face is the smooth patch of the mesh around a
 * picked point: the triangle closest to the point, grown across shared edges whose dihedral angle stays below FACE_CREASE_ANGLE (the
 * viewport's crease angle, so a face is what the viewport draws as one smooth surface). Exact-kernel meshes keep separate vertices per
 * B-rep face, so there a patch never leaves its B-rep face; welded meshes (Manifold, imports) stop at creases.
 */

import type { Entity, FaceColor, FaceSignature, MeshData, Vec3 } from '../model/types';
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

/** What identifies a patch across a resize: see `FaceSignature`. */
interface Parts {
  /** `owner[t]` = ordinal of the patch of triangle `t`. */
  readonly owner: readonly number[];
  /** Per patch ordinal: its largest triangle (a point on it that no neighbouring patch ties with). */
  readonly reps: readonly number[];
  /** Per patch ordinal: its signature (null for a patch of no area). */
  readonly sigs: ReadonlyArray<FaceSignature | null>;
}

/** The smooth patches of one mesh: closest triangle to a point, the patch grown from it, and the whole partition. */
interface MeshFaces {
  /** Closest triangle to `point` (a sliver only when no triangle has area) and its distance (-1 / Infinity on an empty mesh). */
  readonly closest: (point: Vec3) => { readonly triangle: number; readonly distance: number };
  /** Triangles of the smooth patch containing `seed`. */
  readonly patch: (seed: number) => ReadonlySet<number>;
  readonly partition: () => Parts;
  readonly centroid: (triangle: number) => Vec3;
}

/**
 * Signature tolerances. Mean normals must differ by less than this: separate patches meet at a crease of 30 degrees or more, so the unit normals of
 * neighbouring facets differ by at least 2 sin(15 deg) = 0.52, and a whole wall (mean 0) differs from a facet strip (unit) by 1: 0.4 leaves 0.12 of margin.
 */
const SIGNATURE_NORMAL_TOLERANCE = 0.4;
/** Centres, as fractions of the body's box: neighbouring faces of a box differ by 0.5 or more. */
const SIGNATURE_CENTRE_TOLERANCE = 0.35;
/** Extents of the patch's own box, as fractions of the body's box: separates coaxial walls of different radius (a step of 1 against 1.5 in a body of 6 is 0.17). */
const SIGNATURE_SPAN_TOLERANCE = 0.1;

/**
 * Ordinal of the patch matching `target` (same outward sign; normal, centre and span within tolerance), or -1 when none does or SEVERAL do: a
 * second candidate means the signature no longer tells its face from another (stepped coaxial walls), and the caller re-picks or drops.
 */
function matchSignature(sigs: ReadonlyArray<FaceSignature | null>, target: FaceSignature): number {
  const found: number[] = [];
  sigs.forEach((sig, ordinal) => {
    if (sig === null || sig.outward !== target.outward) return;
    const within =
      len3(sub3(sig.normal, target.normal)) <= SIGNATURE_NORMAL_TOLERANCE &&
      len3(sub3(sig.centre, target.centre)) <= SIGNATURE_CENTRE_TOLERANCE &&
      len3(sub3(sig.span, target.span)) <= SIGNATURE_SPAN_TOLERANCE;
    if (within) found.push(ordinal);
  });
  return found.length === 1 ? (found[0] as number) : -1;
}

/**
 * The mean normal `m` as it reads in the body's own box coordinates (x / size per axis): direction of m (.) size, kept at the length of m (a whole wall
 * has none). A per-axis resize (a pyramid taller by 10, a wedge flattened) leaves it unchanged, where the world normal of a slanted face turns.
 */
function normalInBox(m: Vec3, size: readonly number[]): Vec3 {
  const scaled: Vec3 = [m[0] * (size[0] as number), m[1] * (size[1] as number), m[2] * (size[2] as number)];
  const length = len3(scaled);
  const keep = len3(m);
  return length === 0 ? [0, 0, 0] : [(scaled[0] / length) * keep, (scaled[1] / length) * keep, (scaled[2] / length) * keep];
}

function patchSignatures(tris: IndexedTriangles, owner: readonly number[], count: number): Array<FaceSignature | null> {
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < tris.count * 3; i++) {
    const v = tris.vertex(i);
    for (let k = 0; k < 3; k++) [lo[k], hi[k]] = [Math.min(lo[k] as number, v[k] as number), Math.max(hi[k] as number, v[k] as number)];
  }
  const size = hi.map((h, k) => Math.max(h - (lo[k] as number), 1e-12));
  const middle: Vec3 = [0, 1, 2].map((k) => ((hi[k] as number) + (lo[k] as number)) / 2) as unknown as Vec3;
  const areaVector = Array.from({ length: count }, () => [0, 0, 0]);
  const centreSum = Array.from({ length: count }, () => [0, 0, 0]);
  const area = new Array<number>(count).fill(0);
  const outward = new Array<number>(count).fill(0);
  const boxLo = Array.from({ length: count }, () => [Infinity, Infinity, Infinity]);
  const boxHi = Array.from({ length: count }, () => [-Infinity, -Infinity, -Infinity]);
  for (let t = 0; t < tris.count; t++) {
    const [a, b, c] = triangleAt(tris, t);
    const doubled = cross3(sub3(b, a), sub3(c, a));
    const size2 = len3(doubled);
    const p = owner[t] as number;
    if (size2 === 0) continue;
    const centre: Vec3 = [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3];
    const half = size2 / 2;
    for (const corner of [a, b, c])
      for (let k = 0; k < 3; k++) {
        (boxLo[p] as number[])[k] = Math.min((boxLo[p] as number[])[k] as number, corner[k] as number);
        (boxHi[p] as number[])[k] = Math.max((boxHi[p] as number[])[k] as number, corner[k] as number);
      }
    for (let k = 0; k < 3; k++) {
      (areaVector[p] as number[])[k] = ((areaVector[p] as number[])[k] as number) + (doubled[k] as number) / 2;
      (centreSum[p] as number[])[k] = ((centreSum[p] as number[])[k] as number) + (centre[k] as number) * half;
    }
    area[p] = (area[p] as number) + half;
    outward[p] = (outward[p] as number) + (dot3(doubled, sub3(centre, middle)) / 2 / size2) * half;
  }
  return area.map((total, p) => {
    if (total <= 0) return null;
    const [nx, ny, nz] = areaVector[p] as number[];
    const centre = (centreSum[p] as number[]).map((x, k) => (x / total - (lo[k] as number)) / (size[k] as number));
    return {
      normal: normalInBox([(nx as number) / total, (ny as number) / total, (nz as number) / total], size),
      centre: [centre[0] as number, centre[1] as number, centre[2] as number] as const,
      span: [0, 1, 2]
        .map((k) => ((boxHi[p] as number[])[k] as number) - ((boxLo[p] as number[])[k] as number))
        .map((x, k) => x / (size[k] as number)) as unknown as Vec3,
      outward: (outward[p] as number) >= 0 ? (1 as const) : (-1 as const),
    };
  });
}

function meshFaces(mesh: MeshData): MeshFaces {
  const tris = indexedTriangles(mesh);
  const normals = triangleNormals(tris);
  const neighbours = edgeNeighbours(tris, mesh.indices.length > 0);
  const flat = (t: number): boolean => len3(normals[t] ?? [0, 0, 0]) === 0;
  const closest = (point: Vec3): { triangle: number; distance: number } => {
    let triangle = -1;
    let best = Infinity;
    let sliver = true;
    for (let t = 0; t < tris.count; t++) {
      const distance = distanceSq3(closestPointOnTriangle(point, triangleAt(tris, t)), point);
      // a triangle with area always beats a sliver (a collapsed quad edge on an axis lies on every neighbouring face)
      if ((sliver && !flat(t)) || (sliver === flat(t) && distance < best)) [triangle, best, sliver] = [t, distance, flat(t)];
    }
    return { triangle, distance: Math.sqrt(best) };
  };
  /** A sliver may join a patch but never carries it on: it bridges faces that only meet at its collapsed edge. */
  const patch = (seed: number): Set<number> => {
    const start = seed >= 0 && flat(seed) ? ((neighbours[seed] ?? []).find((other) => !flat(other)) ?? seed) : seed;
    const reached = new Set(start < 0 ? [] : [start]);
    const queue = start < 0 || flat(start) ? [] : [start];
    for (let next = queue.pop(); next !== undefined; next = queue.pop()) {
      const normal = normals[next] as Vec3;
      for (const other of neighbours[next] ?? []) {
        if (reached.has(other)) continue;
        if (flat(other)) {
          reached.add(other);
          continue;
        }
        if (dot3(normal, normals[other] as Vec3) < FACE_CREASE_COS) continue;
        reached.add(other);
        queue.push(other);
      }
    }
    return reached;
  };
  const partition = (): Parts => {
    const owner: number[] = Array.from({ length: tris.count }, () => -1);
    let count = 0;
    for (let t = 0; t < tris.count; t++) {
      if (owner[t] !== -1 || flat(t)) continue;
      for (const member of patch(t)) if (owner[member] === -1) owner[member] = count;
      count++;
    }
    // slivers no patch reached: the patch of a neighbour, else one of their own
    for (let t = 0; t < tris.count; t++)
      if (owner[t] === -1) owner[t] = owner[(neighbours[t] ?? []).find((other) => (owner[other] ?? -1) !== -1) ?? -1] ?? count++;
    const reps = Array.from({ length: count }, () => -1);
    const biggest = new Array<number>(count).fill(-1);
    for (let t = 0; t < tris.count; t++) {
      const [a, b, c] = triangleAt(tris, t);
      const size2 = len3(cross3(sub3(b, a), sub3(c, a)));
      const p = owner[t] as number;
      if (size2 > (biggest[p] as number)) [biggest[p], reps[p]] = [size2, t];
    }
    return { owner, reps, sigs: patchSignatures(tris, owner, count) };
  };
  const centroid = (t: number): Vec3 => {
    const [a, b, c] = triangleAt(tris, t);
    return [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3];
  };
  return { closest, patch, partition, centroid };
}

/** Triangles an entry colours: the patch matching its signature (parametric solids: invariant under a resize), else the smooth patch around `near`. */
function entryTriangles(faces: MeshFaces, parts: () => Parts, entry: FaceColor): Iterable<number> {
  if (entry.sig !== undefined) {
    const { owner, sigs } = parts();
    // no (or no single) matching face: nothing is coloured; a replayed `set_face_color` re-picks by faceNear and stores a fresh signature
    const ordinal = matchSignature(sigs, entry.sig);
    return ordinal < 0 ? [] : owner.flatMap((patchOf, t) => (patchOf === ordinal ? [t] : []));
  }
  return faces.patch(faces.closest(entry.near).triangle);
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
  let parts: Parts | undefined;
  const partition = (): Parts => (parts ??= faces.partition());
  for (const entry of faceColors) for (const t of entryTriangles(faces, partition, entry)) colors[t] = entry.color;
  return colors;
}

/** Outcome of `mergeFaceColors`: the new list, the picks applied (with the signature of each patch, parametric solids) and the picks farther than the tolerance (ignored). */
interface FaceColorMerge {
  readonly faceColors: FaceColor[];
  readonly applied: Vec3[];
  readonly signatures: FaceSignature[];
  readonly missed: Vec3[];
}

/**
 * `existing` with the faces at `picks` (mesh frame) set to `color`, or reset when `color` is undefined: an existing entry on a picked face is
 * replaced, so recolouring a face never stacks entries. Picks farther than `tolerance` from the mesh are missed. With `bySignature` (parametric
 * solids) each new entry also stores the signature of its patch, which is what drawing and regeneration resolve.
 * @pure
 */
export function mergeFaceColors(
  mesh: MeshData,
  existing: readonly FaceColor[],
  picks: readonly Vec3[],
  color: string | undefined,
  tolerance: number,
  bySignature = false,
): FaceColorMerge {
  const faces = meshFaces(mesh);
  const { owner, sigs } = faces.partition();
  const applied: Vec3[] = [];
  const signatures: FaceSignature[] = [];
  const missed: Vec3[] = [];
  const covered = new Set<number>();
  for (const near of picks) {
    const { triangle, distance } = faces.closest(near);
    const sig = sigs[owner[triangle] ?? -1];
    if (triangle < 0 || distance > tolerance || (bySignature && sig === null)) missed.push(near);
    else {
      applied.push(near);
      if (bySignature) signatures.push(sig as FaceSignature);
      for (const t of bySignature ? owner.flatMap((o, i) => (o === owner[triangle] ? [i] : [])) : faces.patch(triangle)) covered.add(t);
    }
  }
  const seedOf = (entry: FaceColor): number => {
    const ordinal = entry.sig === undefined ? -1 : matchSignature(sigs, entry.sig);
    return ordinal >= 0 ? owner.indexOf(ordinal) : faces.closest(entry.near).triangle;
  };
  const kept = existing.filter((entry) => !covered.has(seedOf(entry)));
  const added = applied.map(
    (near, i): FaceColor => ({ near, color: color ?? '', ...(bySignature ? { sig: signatures[i] as FaceSignature } : {}) }),
  );
  return { faceColors: color === undefined ? kept : [...kept, ...added], applied, signatures, missed };
}

/** For each signature, a point on the patch of `mesh` that matches it (mesh frame), or null when none does. @pure */
export function signaturePoints(mesh: MeshData, signatures: readonly FaceSignature[]): Array<Vec3 | null> {
  const faces = meshFaces(mesh);
  const { reps, sigs } = faces.partition();
  return signatures.map((sig) => {
    const ordinal = matchSignature(sigs, sig);
    return ordinal < 0 ? null : faces.centroid(reps[ordinal] as number);
  });
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
