/**
 * Open meshes and mirror symmetry for `quad_remesh` (07 MSH FR-MSH-22, TECHNICAL_SPEC 13.17). The engine (QuadriFlow) works on one surface and does not put its boundary
 * vertices on the boundary of the input, nor does it know about a mirror plane. These pure steps close both gaps around the engine call:
 * - `snapQuadBoundary`: every boundary loop of the quads is matched to one boundary loop of the source and its vertices are moved onto it;
 * - `orientQuadsToSource`: an open surface has no inside, so each connected piece is wound like the source triangles it lies on;
 * - `mirrorWeld`: the quads of one half of a symmetric source and their mirror image, welded on the plane;
 * - `symmetryProblem` / `halfOf`: the source must be symmetric within a tolerance, and the half the engine remeshes is cut exactly at the plane.
 */

import type { MeshData } from '../../model/types';
import type { Vec3 } from '../../model/vectors';
import { cutMeshByPlane } from './planeCut';
import { faceNormal, shellOfQuads } from './quadCage';
import { SurfaceIndex } from './surfaceIndex';

const at = (positions: ReadonlyArray<number>, index: number): Vec3 => [
  positions[3 * index] as number,
  positions[3 * index + 1] as number,
  positions[3 * index + 2] as number,
];
const sub = (p: Vec3, q: Vec3): Vec3 => [p[0] - q[0], p[1] - q[1], p[2] - q[2]];
const dot = (p: Vec3, q: Vec3): number => p[0] * q[0] + p[1] * q[1] + p[2] * q[2];

type Edge = readonly [number, number];

/** The mirror plane through the origin: yz mirrors x, xz mirrors y, xy mirrors z. */
export const SYMMETRY_AXIS = { yz: 0, xz: 1, xy: 2 } as const;
export type SymmetryPlane = keyof typeof SYMMETRY_AXIS;

/** Fraction of the source diagonal that a vertex may be from the surface of its mirror image (named default; a symmetric scan is symmetric to far better). */
const SYMMETRY_TOLERANCE_FRACTION = 1e-3;
/** Fraction of the source diagonal within which a vertex of the half counts as on the plane and is put exactly on it. */
const ON_PLANE_FRACTION = 1e-9;

/** The directed edges (along their face) used by exactly one face of `size`-gons. */
export function boundaryEdges(indices: ReadonlyArray<number>, size: 3 | 4): Edge[] {
  const uses = new Map<string, number>();
  const directed: Edge[] = [];
  for (let f = 0; f < indices.length / size; f++) {
    for (let k = 0; k < size; k++) {
      const a = indices[f * size + k] as number;
      const b = indices[f * size + ((k + 1) % size)] as number;
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      uses.set(key, (uses.get(key) ?? 0) + 1);
      directed.push([a, b]);
    }
  }
  return directed.filter(([a, b]) => uses.get(a < b ? `${a},${b}` : `${b},${a}`) === 1);
}

/** Boundary edges chained into loops of vertices; null when a vertex has two boundary edges leaving it or a chain does not close. */
export function loopsOf(edges: ReadonlyArray<Edge>): number[][] | null {
  const next = new Map<number, number>();
  for (const [a, b] of edges) {
    if (next.has(a)) return null;
    next.set(a, b);
  }
  const seen = new Set<number>();
  const loops: number[][] = [];
  for (const [start] of edges) {
    if (seen.has(start)) continue;
    const loop: number[] = [];
    let v = start;
    while (!seen.has(v)) {
      seen.add(v);
      loop.push(v);
      const following = next.get(v);
      if (following === undefined) return null;
      v = following;
    }
    if (v !== start) return null;
    loops.push(loop);
  }
  return loops;
}

/** A boundary loop of the source as a closed polyline with arc-length positions. */
export interface RimLoop {
  readonly points: Vec3[];
  /** Arc length at the start of each segment (segment k runs from points[k] to points[k + 1]). */
  readonly starts: number[];
  readonly length: number;
  /** Arc lengths of the corners: where the rim turns by more than RIM_CORNER_DEGREES seen from one quad edge away, and where it joins or leaves the plane `axis` = 0. */
  readonly corners: Array<{ readonly arc: number; readonly k: number }>;
}

/** A turn of the rim by more than this is a corner: a quad vertex is put exactly on it (a square plate keeps its four corners). */
const RIM_CORNER_DEGREES = 60;

export function rimLoop(source: MeshData, loop: ReadonlyArray<number>, axis: number | null, scale: number): RimLoop {
  const points = loop.map((v) => at(source.positions, v));
  const starts: number[] = [];
  let length = 0;
  points.forEach((p, k) => {
    starts.push(length);
    const d = sub(points[(k + 1) % points.length] as Vec3, p);
    length += Math.hypot(d[0], d[1], d[2]);
  });
  const rim: RimLoop = { points, starts, length, corners: [] };
  const onPlane = (a: Vec3, b: Vec3): boolean => axis !== null && a[axis] === 0 && b[axis] === 0;
  // where the rim joins or leaves the plane: always a corner
  const corners: Array<{ arc: number; k: number }> = [];
  points.forEach((q, k) => {
    const [p, r] = [points[(k + points.length - 1) % points.length] as Vec3, points[(k + 1) % points.length] as Vec3];
    if (onPlane(p, q) !== onPlane(q, r)) corners.push({ arc: starts[k] as number, k });
  });
  // where it turns by more than RIM_CORNER_DEGREES seen from one quad edge away (a rim of tiny jagged triangles does not turn at that scale), the sharpest first,
  // none within one quad edge of another corner
  const reach = Math.min(scale, length / 8);
  const apart = (x: number, y: number): number => Math.abs(x - y - length * Math.round((x - y) / length));
  const cosine = Math.cos((RIM_CORNER_DEGREES * Math.PI) / 180);
  const turns = points
    .map((q, k) => {
      const arc = starts[k] as number;
      const incoming = sub(q, rimPointAt(rim, arc - reach));
      const outgoing = sub(rimPointAt(rim, arc + reach), q);
      const norms = Math.hypot(...incoming) * Math.hypot(...outgoing);
      return { arc, k, cosine: norms > 0 ? dot(incoming, outgoing) / norms : 1 };
    })
    .filter((t) => t.cosine < cosine)
    .sort((x, y) => x.cosine - y.cosine);
  for (const t of turns) if (corners.every((c) => apart(c.arc, t.arc) > reach)) corners.push({ arc: t.arc, k: t.k });
  return { points, starts, length, corners };
}

/** The mean length of the edges of the quads. */
export function meanEdge(positions: ReadonlyArray<number>, quads: ReadonlyArray<number>): number {
  let sum = 0;
  for (let f = 0; f < quads.length / 4; f++)
    for (let k = 0; k < 4; k++) {
      const d = sub(at(positions, quads[4 * f + k] as number), at(positions, quads[4 * f + ((k + 1) % 4)] as number));
      sum += Math.hypot(d[0], d[1], d[2]);
    }
  return quads.length === 0 ? 0 : sum / quads.length;
}

/** The point of the rim at arc length `u` (any real: wrapped). A point of a segment with both ends on a coordinate plane has that coordinate exactly 0 (0 + s x 0). */
export function rimPointAt(rim: RimLoop, u: number): Vec3 {
  const wrapped = ((u % rim.length) + rim.length) % rim.length;
  // the last segment that starts at or before the point (binary search: the starts are ascending)
  let [low, high] = [0, rim.starts.length - 1];
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if ((rim.starts[middle] as number) > wrapped) high = middle - 1;
    else low = middle;
  }
  const k = low;
  const [p, q] = [rim.points[k] as Vec3, rim.points[(k + 1) % rim.points.length] as Vec3];
  const span = (rim.starts[k + 1] ?? rim.length) - (rim.starts[k] as number);
  const s = span === 0 ? 0 : (wrapped - (rim.starts[k] as number)) / span;
  return [p[0] + s * (q[0] - p[0]), p[1] + s * (q[1] - p[1]), p[2] + s * (q[2] - p[2])];
}

/** The arc length of the point of the rim nearest to `p`, and the distance. */
export function rimArc(rim: RimLoop, p: Vec3): { arc: number; distance: number } {
  // scalar arithmetic only: the loop runs once per segment of the rim for every vertex asked about
  let bestSquared = Infinity;
  let bestArc = 0;
  const count = rim.points.length;
  for (let k = 0; k < count; k++) {
    const a = rim.points[k] as Vec3;
    const b = rim.points[k + 1 < count ? k + 1 : 0] as Vec3;
    const abx = b[0] - a[0];
    const aby = b[1] - a[1];
    const abz = b[2] - a[2];
    const length2 = abx * abx + aby * aby + abz * abz;
    const s = length2 === 0 ? 0 : Math.min(1, Math.max(0, ((p[0] - a[0]) * abx + (p[1] - a[1]) * aby + (p[2] - a[2]) * abz) / length2));
    const dx = p[0] - (a[0] + s * abx);
    const dy = p[1] - (a[1] + s * aby);
    const dz = p[2] - (a[2] + s * abz);
    const squared = dx * dx + dy * dy + dz * dz;
    if (squared < bestSquared) {
      bestSquared = squared;
      bestArc = (rim.starts[k] as number) + s * Math.sqrt(length2);
    }
  }
  return { arc: bestArc, distance: Math.sqrt(bestSquared) };
}

/** Gaps between neighbouring snapped vertices are at least this fraction of the rim length over the number of vertices (so no quad is collapsed by the order fix). */
const MIN_GAP_FRACTION = 1e-3;

/**
 * Why the boundary cannot be snapped: `source` the source's own boundary is not a set of simple loops (a pinch: repair it), `loops` the quads' boundary loops are not the source's
 * one for one (a hole the engine covered, loops it merged), `shape` the loops are there but cannot be placed on the rim without folding or reordering quads.
 */
export interface SnapProblem {
  readonly cause: 'source' | 'loops' | 'shape';
  readonly message: string;
}

const problem = (cause: SnapProblem['cause'], message: string): SnapProblem => ({ cause, message });

export interface BoundarySnap {
  readonly positions: number[];
  readonly loops: number;
  /** The largest distance a vertex was moved. */
  readonly worstMove: number;
}

/**
 * Move the boundary vertices of `quads` onto the boundary of `source`, in order. Every boundary loop of the quads must follow exactly one boundary loop of the source
 * (all its vertices are nearest to the same source loop, no two quad loops to the same one) and the loops of the two must be equal in number, else a problem text is
 * returned. A vertex goes to the point of its source loop at the arc length it projects to; the arc lengths of a quad loop are unwrapped and made strictly monotone in the
 * direction the loop goes round (a staircase boundary projects some neighbours out of order, which would fold the quads between them), and the loop must go round the rim
 * once. A vertex on a source segment with both ends on the plane `axis` = 0 lands exactly on it (its coordinate is 0 + s x 0). No quad may be folded or collapsed by the move.
 */
export function snapQuadBoundary(
  source: MeshData,
  positions: ReadonlyArray<number>,
  quads: ReadonlyArray<number>,
  axis: number | null,
): BoundarySnap | SnapProblem {
  const sourceLoops = loopsOf(boundaryEdges(source.indices, 3));
  const quadLoops = loopsOf(boundaryEdges(quads, 4));
  if (sourceLoops === null)
    return problem('source', 'the boundary of the source is not a set of simple loops (an edge chain branches or does not close)');
  if (quadLoops === null) return problem('shape', "the boundary of the engine's quads is not a set of simple loops");
  if (sourceLoops.length !== quadLoops.length)
    return problem('loops', `the engine's quads have ${quadLoops.length} boundary loop(s) against ${sourceLoops.length} in the source`);
  const rims = sourceLoops.map((loop) => rimLoop(source, loop, axis, meanEdge(positions, quads)));
  const moved = positions.slice();
  const owner = new Set<number>();
  let worstMove = 0;
  for (const loop of quadLoops) {
    const points = loop.map((v) => at(positions, v));
    // the source loop each vertex is nearest to, and the arc length it projects to
    const nearest = points.map((p) => {
      const found = rims.map((rim, id) => ({ id, ...rimArc(rim, p) }));
      return found.reduce((best, f) => (f.distance < best.distance ? f : best));
    });
    const loopId = (nearest[0] as { id: number }).id;
    if (nearest.some((n) => n.id !== loopId))
      return problem('loops', "a boundary loop of the engine's quads runs along more than one boundary loop of the source");
    if (owner.has(loopId)) return problem('loops', "two boundary loops of the engine's quads follow the same boundary loop of the source");
    owner.add(loopId);
    const rim = rims[loopId] as RimLoop;
    const wrap = (d: number): number => d - rim.length * Math.round(d / rim.length);
    const unwrapped = [(nearest[0] as { arc: number }).arc];
    for (let i = 1; i < nearest.length; i++)
      unwrapped.push((unwrapped[i - 1] as number) + wrap((nearest[i] as { arc: number }).arc - (nearest[i - 1] as { arc: number }).arc));
    const turn =
      (unwrapped[unwrapped.length - 1] as number) +
      wrap((nearest[0] as { arc: number }).arc - (nearest[nearest.length - 1] as { arc: number }).arc) -
      (unwrapped[0] as number);
    if (Math.abs(turn) < rim.length / 2)
      return problem('shape', "a boundary loop of the engine's quads does not go once round the boundary loop of the source it follows");
    const direction = Math.sign(turn);
    const gap = (MIN_GAP_FRACTION * rim.length) / loop.length;
    // each corner of the rim gets the quad vertex nearest to it, exactly (two corners never share a vertex)
    const pinned = new Map<number, number>();
    for (const { arc: corner, k } of rim.corners) {
      let best = -1;
      let bestDistance = Infinity;
      unwrapped.forEach((u, i) => {
        const distance = Math.abs(wrap(u - corner));
        if (!pinned.has(i) && distance < bestDistance) [best, bestDistance] = [i, distance];
      });
      if (best < 0)
        return problem(
          'shape',
          `a boundary loop of the engine's quads has fewer vertices than the ${rim.corners.length} corners of the boundary loop it follows`,
        );
      pinned.set(best, k);
      unwrapped[best] = (unwrapped[best] as number) + wrap(corner - (unwrapped[best] as number));
    }
    // strictly monotone in the direction of the loop, the pinned vertices where they are
    const ordered = (a: number, b: number): boolean => (direction > 0 ? b - a >= gap : a - b >= gap);
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 1; i < unwrapped.length; i++)
        if (!ordered(unwrapped[i - 1] as number, unwrapped[i] as number) && !pinned.has(i))
          unwrapped[i] = (unwrapped[i - 1] as number) + direction * gap;
      for (let i = unwrapped.length - 2; i >= 0; i--)
        if (!ordered(unwrapped[i] as number, unwrapped[i + 1] as number) && !pinned.has(i))
          unwrapped[i] = (unwrapped[i + 1] as number) - direction * gap;
    }
    for (let i = 1; i < unwrapped.length; i++)
      if (!ordered(unwrapped[i - 1] as number, unwrapped[i] as number))
        return problem(
          'shape',
          "the corners of a boundary loop of the source cannot be given their own vertices of the engine's quads in order",
        );
    if (Math.abs((unwrapped[unwrapped.length - 1] as number) - (unwrapped[0] as number)) + gap >= rim.length)
      return problem(
        'shape',
        "the vertices of a boundary loop of the engine's quads do not fit once round the boundary loop of the source in order",
      );
    loop.forEach((v, i) => {
      // a corner vertex sits exactly on the corner of the rim, the others at their arc length
      const corner = pinned.get(i);
      const target: number[] = [...(corner !== undefined ? (rim.points[corner] as Vec3) : rimPointAt(rim, unwrapped[i] as number))];
      const p = points[i] as Vec3;
      worstMove = Math.max(worstMove, Math.hypot(p[0] - (target[0] as number), p[1] - (target[1] as number), p[2] - (target[2] as number)));
      moved[3 * v] = target[0] as number;
      moved[3 * v + 1] = target[1] as number;
      moved[3 * v + 2] = target[2] as number;
    });
  }
  for (let f = 0; f < quads.length / 4; f++) {
    const corners = [0, 1, 2, 3].map((k) => quads[4 * f + k] as number);
    if (
      !corners.some(
        (v) => positions[3 * v] !== moved[3 * v] || positions[3 * v + 1] !== moved[3 * v + 1] || positions[3 * v + 2] !== moved[3 * v + 2],
      )
    )
      continue;
    const before = faceNormal(positions, quads, f);
    const after = faceNormal(moved, quads, f);
    if (!(dot(before, after) > 0)) return problem('shape', `snapping the boundary onto the source folds or collapses quad ${f}`);
  }
  return { positions: moved, loops: quadLoops.length, worstMove };
}

/** The quads wound like the source: each connected piece is reversed as a whole when its quads face away from the source triangles they lie on (most of them, by area-free count). */
export function orientQuadsToSource(source: MeshData, positions: ReadonlyArray<number>, quads: ReadonlyArray<number>): number[] {
  const { shell, count } = shellOfQuads(quads, positions.length / 3);
  const index = new SurfaceIndex(source.positions, source.indices);
  const vote = new Array<number>(count).fill(0);
  for (let f = 0; f < quads.length / 4; f++) {
    const corners = [0, 1, 2, 3].map((k) => at(positions, quads[4 * f + k] as number));
    const mean = (a: 0 | 1 | 2): number => corners.reduce((s, p) => s + p[a], 0) / 4;
    const centre: Vec3 = [mean(0), mean(1), mean(2)];
    const face = index.closest(centre).face;
    if (face < 0) continue;
    const [p, q, r] = [0, 1, 2].map((k) => at(source.positions, source.indices[3 * face + k] as number)) as [Vec3, Vec3, Vec3];
    const [u, v] = [sub(q, p), sub(r, p)];
    const normal: Vec3 = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const s = shell[f] as number;
    vote[s] = (vote[s] as number) + Math.sign(dot(faceNormal(positions, quads, f), normal));
  }
  const out: number[] = [];
  for (let f = 0; f < quads.length / 4; f++) {
    const [a, b, c, d] = [0, 1, 2, 3].map((k) => quads[4 * f + k] as number) as [number, number, number, number];
    if ((vote[shell[f] as number] as number) >= 0) out.push(a, b, c, d);
    else out.push(a, d, c, b);
  }
  return out;
}

/**
 * Why `source` is not symmetric about `plane`, or null: the largest distance from a mirrored vertex to the source surface (one closest-point query per vertex)
 * may not exceed SYMMETRY_TOLERANCE_FRACTION x the source diagonal.
 */
export function symmetryProblem(source: MeshData, plane: SymmetryPlane, diagonal: number): string | null {
  const axis = SYMMETRY_AXIS[plane];
  const index = new SurfaceIndex(source.positions, source.indices);
  let worst = 0;
  for (let v = 0; v < source.positions.length / 3; v++) {
    const p = at(source.positions, v);
    const mirrored: Vec3 = [axis === 0 ? -p[0] : p[0], axis === 1 ? -p[1] : p[1], axis === 2 ? -p[2] : p[2]];
    worst = Math.max(worst, index.closest(mirrored).distance);
  }
  const tolerance = SYMMETRY_TOLERANCE_FRACTION * diagonal;
  return worst <= tolerance
    ? null
    : `the source is not symmetric about the ${plane} plane: a vertex is ${worst.toPrecision(3)} from the surface of its mirror image (tolerance ${tolerance.toPrecision(3)}, ${SYMMETRY_TOLERANCE_FRACTION * 100} % of the diagonal)`;
}

/**
 * The half of `source` on the positive side of the plane through the origin, clipped exactly at it, its vertices on the plane put on it; `empty` when nothing is on that
 * side, or `flat` (with the count) when triangles lie in the plane (the half would be open along them, and which half they belong to is undefined).
 */
export function halfOf(source: MeshData, plane: SymmetryPlane, diagonal: number): MeshData | 'empty' | { readonly flat: number } {
  const axis = SYMMETRY_AXIS[plane];
  const normal: Vec3 = [axis === 0 ? 1 : 0, axis === 1 ? 1 : 0, axis === 2 ? 1 : 0];
  let flat = 0;
  for (let t = 0; t < source.indices.length; t += 3)
    if (
      [0, 1, 2].every(
        (k) => Math.abs(source.positions[3 * (source.indices[t + k] as number) + axis] as number) <= ON_PLANE_FRACTION * diagonal,
      )
    )
      flat++;
  if (flat > 0) return { flat };
  const half = cutMeshByPlane(source, [0, 0, 0], normal, 1, false, 1e-12 * diagonal).mesh;
  if (half.indices.length === 0) return 'empty';
  const positions = half.positions.map((v, i) => (i % 3 === axis && Math.abs(v) <= ON_PLANE_FRACTION * diagonal ? 0 : v));
  return { positions, indices: half.indices };
}

/** `quads` (the half, vertices on the plane exactly 0 on `axis`) and their mirror image in one quad mesh, the vertices on the plane shared. */
export function mirrorWeld(
  positions: ReadonlyArray<number>,
  quads: ReadonlyArray<number>,
  axis: number,
): { positions: number[]; quads: number[] } {
  const count = positions.length / 3;
  const twin = new Array<number>(count);
  const out = positions.slice();
  for (let v = 0; v < count; v++) {
    if (positions[3 * v + axis] === 0) twin[v] = v;
    else {
      twin[v] = out.length / 3;
      out.push(...[0, 1, 2].map((a) => (a === axis ? -(positions[3 * v + a] as number) : (positions[3 * v + a] as number))));
    }
  }
  const mirrored: number[] = [];
  for (let f = 0; f < quads.length / 4; f++) {
    const [a, b, c, d] = [0, 1, 2, 3].map((k) => twin[quads[4 * f + k] as number] as number) as [number, number, number, number];
    mirrored.push(a, d, c, b);
  }
  return { positions: out, quads: [...quads, ...mirrored] };
}
