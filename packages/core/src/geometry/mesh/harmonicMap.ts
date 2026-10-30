/**
 * Harmonic-map parameterisation of a disk-topology region of a triangle mesh (07 MSH FR-MSH-24, TECHNICAL_SPEC 13.23): the boundary loop goes onto the boundary of the unit
 * parameter square, by arc length between four corner VERTICES (the sharpest turns of the boundary, else the vertices nearest to the quarter points of its length), every
 * interior vertex is the weighted mean of its neighbours (the discrete Laplace equation with the cotangent weights, Jacobi-preconditioned conjugate gradient), and a result
 * with a flipped triangle is solved again with Floater's mean-value weights (positive, so with a convex boundary an embedding; BiCGSTAB, warm-started from the first solve)
 * before the region is refused. Every solve has an iteration budget and a stall check: a region the budget cannot solve is refused by name, never waited for.
 * @invariant the region needs one connected, manifold, consistently wound surface with exactly one boundary loop of at least 4 vertices and Euler characteristic 1; the
 *   parameters of the boundary run counter-clockwise when the triangles face the viewer, so du x dv follows the triangle normals; every corner of the square is the parameter of a vertex
 */

import { biCgStab } from '../../lib/biCgStab';
import { conjugateGradient } from '../../lib/conjugateGradient';
import type { MeshData } from '../../model/types';
import type { Vec3 } from '../../model/vectors';

export interface HarmonicMap {
  /** Parameters (u, v) in [0, 1] of every vertex of the region, by mesh vertex index. */
  readonly uv: Map<number, [number, number]>;
  /** The weights of the accepted solve: the exact cotangent weights, or Floater's mean-value weights after the exact ones flipped a triangle. */
  readonly weights: 'cotangent' | 'mean_value';
  /** Triangles of the exact-cotangent solve whose parameter triangle had a negative area (0 when its result was accepted). */
  readonly flippedFirst: number;
  /** Triangles whose parameter triangle has no area (all three vertices on one side of the square): not flipped, counted. */
  readonly collapsedInParameters: number;
  readonly interiorVertices: number;
  readonly boundaryVertices: number;
  /** Iterations of the accepted solve (u and v together) and the worst final relative residual. */
  readonly cgIterations: number;
  readonly cgResidual: number;
  /** Boundary vertices put at the four corners of the square, in counter-clockwise order. */
  readonly corners: readonly [number, number, number, number];
}

export interface HarmonicRefusal {
  readonly code: 'MESH_FIT_NOT_DISK' | 'MESH_FIT_PARAM_FOLDED';
  readonly message: string;
}

export interface HarmonicOptions {
  /** Iterations a solve may take per coordinate (default `iterationBudget`). */
  readonly maxIterations?: number;
}

/** Relative residual of the solves. */
const HARMONIC_TOLERANCE = 1e-9;
/** A parameter triangle with a signed area below minus this (the square has area 1) is flipped. */
const FLIP_AREA = -1e-12;
/** A boundary vertex that turns by more than this (radians, about 20 degrees, over a window of 1/32 of the boundary on each side) is a corner candidate. */
const CORNER_TURN = 0.35;
/** Corners are at least this share of the boundary length apart. */
const CORNER_SEPARATION = 1 / 16;
/** Iterations between two stall checks (the residual must fall by 1 % in each). */
const STALL_WINDOW = 400;
/** Iterations per coordinate a solve may take at most. */
const ITERATION_CAP = 4000;
/** Boundary vertices a disk needs: one per corner of the square. */
const MIN_BOUNDARY_VERTICES = 4;

/** Iterations per coordinate a region of `n` interior vertices is given: the system is solved in about 1.5 sqrt(n) of them, with a margin. */
export const iterationBudget = (n: number): number => Math.min(4 * n, ITERATION_CAP, 400 + Math.ceil(12 * Math.sqrt(n)));

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

const notDisk = (message: string): HarmonicRefusal => ({ code: 'MESH_FIT_NOT_DISK', message });

interface Topology {
  readonly vertices: number[];
  /** Boundary loop, mesh vertex indices in the direction of the faces. */
  readonly loop: number[];
  readonly edges: number;
}

/** The vertices and the boundary loop of the region, or the reason it is not a disk. */
function diskTopology(mesh: MeshData, faces: ReadonlyArray<number>): Topology | HarmonicRefusal {
  const vertexCount = mesh.positions.length / 3;
  const directed = new Set<number>();
  const seen = new Set<number>();
  const listed = new Set<number>();
  for (const f of faces) {
    if (listed.has(f)) return notDisk(`triangle ${f} is listed twice in the region`);
    listed.add(f);
    for (let k = 0; k < 3; k++) {
      const a = mesh.indices[3 * f + k] as number;
      const b = mesh.indices[3 * f + ((k + 1) % 3)] as number;
      seen.add(a);
      if (a === b) return notDisk(`triangle ${f} has a repeated vertex`);
      const key = a * vertexCount + b;
      if (directed.has(key))
        return notDisk(
          `the region is not a consistently wound manifold: the edge ${a}-${b} is used twice in the same direction (triangle ${f}, a duplicate or a flipped neighbour)`,
        );
      directed.add(key);
    }
  }
  const vertices = [...seen].sort((x, y) => x - y);
  const next = new Map<number, number>();
  let edges = 0;
  for (const key of directed) {
    const [a, b] = [Math.floor(key / vertexCount), key % vertexCount];
    const reversed = directed.has(b * vertexCount + a);
    if (a < b || !reversed) edges++;
    if (reversed) continue;
    if (next.has(a)) return notDisk(`the boundary of the region touches itself at vertex ${a} (a pinch): it is not a disk`);
    next.set(a, b);
  }
  if (next.size === 0)
    return notDisk('the region is closed (it has no boundary loop): cut it open or pick a region, e.g. with a sphere or faceGroups');
  // loops of the boundary
  const visited = new Set<number>();
  const loops: number[][] = [];
  for (const start of [...next.keys()].sort((x, y) => x - y)) {
    if (visited.has(start)) continue;
    const loop: number[] = [];
    for (let v = start; !visited.has(v); v = next.get(v) as number) {
      visited.add(v);
      loop.push(v);
    }
    loops.push(loop);
  }
  if (loops.length !== 1)
    return notDisk(
      `the region has ${loops.length} boundary loops (holes): a disk has exactly one; fill_mesh_holes or pick a region without holes`,
    );
  // connected through shared edges
  const owner = new Map<number, number[]>();
  faces.forEach((f, i) => {
    for (let k = 0; k < 3; k++) {
      const a = mesh.indices[3 * f + k] as number;
      const b = mesh.indices[3 * f + ((k + 1) % 3)] as number;
      const key = Math.min(a, b) * vertexCount + Math.max(a, b);
      owner.set(key, [...(owner.get(key) ?? []), i]);
    }
  });
  const reached = new Uint8Array(faces.length);
  const stack = [0];
  reached[0] = 1;
  let count = 1;
  while (stack.length > 0) {
    const i = stack.pop() as number;
    const f = faces[i] as number;
    for (let k = 0; k < 3; k++) {
      const a = mesh.indices[3 * f + k] as number;
      const b = mesh.indices[3 * f + ((k + 1) % 3)] as number;
      for (const j of owner.get(Math.min(a, b) * vertexCount + Math.max(a, b)) ?? [])
        if (reached[j] === 0) {
          reached[j] = 1;
          count++;
          stack.push(j);
        }
    }
  }
  if (count !== faces.length)
    return notDisk(
      `the region is in several pieces (${faces.length - count} of its ${faces.length} triangles are not joined to the first by edges)`,
    );
  const euler = vertices.length - edges + faces.length;
  if (euler !== 1) return notDisk(`the region has Euler characteristic ${euler} with one boundary loop (a disk has 1): it has handles`);
  if ((loops[0] as number[]).length < MIN_BOUNDARY_VERTICES)
    return notDisk(
      `the boundary of the region has ${(loops[0] as number[]).length} vertices: the four corners of the parameter square need at least ${MIN_BOUNDARY_VERTICES} (a single triangle cannot be mapped)`,
    );
  return { vertices, loop: loops[0] as number[], edges };
}

/**
 * The positions in `loop` of the four corners of the square, ascending: the boundary vertices that turn most (above CORNER_TURN, at least CORNER_SEPARATION of the
 * length apart), the largest gaps then split at their middle (the vertex nearest to it) until there are four.
 */
function pickCorners(loop: ReadonlyArray<number>, point: (v: number) => Vec3, arc: ReadonlyArray<number>, perimeter: number): number[] {
  const n = loop.length;
  // the turn is measured over a window of about 1/32 of the vertices on each side: a zigzag boundary (the cut of a sphere) turns sharply at every vertex but not over a window
  const window = Math.max(1, Math.round(n / 32));
  const turning = loop.map((v, i) => {
    const [before, here, ahead] = [point(loop[(i + n - (window % n)) % n] as number), point(v), point(loop[(i + window) % n] as number)];
    const [a, b] = [sub(here, before), sub(ahead, here)];
    return Math.atan2(Math.hypot(...cross(a, b)), dot(a, b));
  });
  const apart = (i: number, j: number): number => {
    const d = Math.abs((arc[i] as number) - (arc[j] as number));
    return Math.min(d, perimeter - d);
  };
  const chosen: number[] = [];
  const sharp = turning.map((t, i) => [t, i] as const).filter(([t]) => t >= CORNER_TURN);
  sharp.sort((x, y) => y[0] - x[0] || x[1] - y[1]);
  for (const [, i] of sharp) if (chosen.length < 4 && chosen.every((c) => apart(i, c) >= CORNER_SEPARATION * perimeter)) chosen.push(i);
  if (chosen.length === 0) chosen.push(0);
  while (chosen.length < 4) {
    const sorted = [...chosen].sort((x, y) => x - y);
    let [gapStart, gap] = [0, -1];
    sorted.forEach((c, k) => {
      const nextArc = k + 1 < sorted.length ? (arc[sorted[k + 1] as number] as number) : perimeter + (arc[sorted[0] as number] as number);
      if (nextArc - (arc[c] as number) > gap) [gapStart, gap] = [c, nextArc - (arc[c] as number)];
    });
    const target = ((arc[gapStart] as number) + gap / 2) % perimeter;
    let best = -1;
    for (let i = 0; i < n; i++) {
      if (chosen.includes(i)) continue;
      const d = Math.abs((arc[i] as number) - target);
      if (
        best < 0 ||
        Math.min(d, perimeter - d) <
          Math.min(Math.abs((arc[best] as number) - target), perimeter - Math.abs((arc[best] as number) - target))
      )
        best = i;
    }
    chosen.push(best);
  }
  return chosen.sort((x, y) => x - y);
}

/** Position on the boundary of the unit square (counter-clockwise from (0, 0)): side `side` (0..3), the share `f` of it. */
const onSide = (side: number, f: number): [number, number] =>
  side === 0 ? [f, 0] : side === 1 ? [1, f] : side === 2 ? [1 - f, 1] : [0, 1 - f];

interface System {
  /** Interior vertices (mesh indices). */
  readonly interior: number[];
  readonly diagonal: Float64Array;
  /** Compressed rows: the interior neighbours of interior vertex i are `cols[rowStart[i] .. rowStart[i + 1])` (interior indices) with weights `vals`. */
  readonly rowStart: Int32Array;
  readonly cols: Int32Array;
  readonly vals: Float64Array;
  readonly rhsU: Float64Array;
  readonly rhsV: Float64Array;
}

const pointOf =
  (mesh: MeshData) =>
  (v: number): Vec3 => [mesh.positions[3 * v] as number, mesh.positions[3 * v + 1] as number, mesh.positions[3 * v + 2] as number];

/** Cotangent weight of every undirected edge of the region (half the sum of the cotangents of the angles opposite it), keyed `min * vertexCount + max`. */
function cotangentWeights(mesh: MeshData, faces: ReadonlyArray<number>): Map<number, number> {
  const vertexCount = mesh.positions.length / 3;
  const point = pointOf(mesh);
  const weights = new Map<number, number>();
  for (const f of faces) {
    const ids = [0, 1, 2].map((k) => mesh.indices[3 * f + k] as number);
    for (let k = 0; k < 3; k++) {
      const [apex, a, b] = [ids[k] as number, ids[(k + 1) % 3] as number, ids[(k + 2) % 3] as number];
      const [ea, eb] = [sub(point(a), point(apex)), sub(point(b), point(apex))];
      const area2 = Math.hypot(...cross(ea, eb));
      if (!(area2 > 0)) continue;
      const key = Math.min(a, b) * vertexCount + Math.max(a, b);
      weights.set(key, (weights.get(key) ?? 0) + dot(ea, eb) / area2 / 2);
    }
  }
  return weights;
}

/** Floater's mean-value weight of every DIRECTED edge i -> j of the region (the tangents of the half angles at i of its two triangles over its length), keyed `i * vertexCount + j`. */
function meanValueWeights(mesh: MeshData, faces: ReadonlyArray<number>): Map<number, number> {
  const vertexCount = mesh.positions.length / 3;
  const point = pointOf(mesh);
  const weights = new Map<number, number>();
  for (const f of faces) {
    const ids = [0, 1, 2].map((k) => mesh.indices[3 * f + k] as number);
    for (let k = 0; k < 3; k++) {
      const [apex, a, b] = [ids[k] as number, ids[(k + 1) % 3] as number, ids[(k + 2) % 3] as number];
      const [ea, eb] = [sub(point(a), point(apex)), sub(point(b), point(apex))];
      const [la, lb, area2] = [Math.hypot(...ea), Math.hypot(...eb), Math.hypot(...cross(ea, eb))];
      if (!(area2 > 0)) continue;
      // tan(theta / 2) = |ea x eb| / (|ea| |eb| + ea . eb)
      const half = area2 / (la * lb + dot(ea, eb));
      for (const [other, length] of [
        [a, la],
        [b, lb],
      ] as const) {
        const key = apex * vertexCount + other;
        weights.set(key, (weights.get(key) ?? 0) + half / length);
      }
    }
  }
  return weights;
}

/** The linear system of the interior vertices for the directed weights `weight(i, j)` (row i: sum_j w_ij (x_i - x_j) = 0, the boundary neighbours on the right). */
function systemOf(
  mesh: MeshData,
  faces: ReadonlyArray<number>,
  topology: Topology,
  weight: (i: number, j: number) => number,
  boundaryUv: Map<number, [number, number]>,
): System {
  const vertexCount = mesh.positions.length / 3;
  const interior = topology.vertices.filter((v) => !boundaryUv.has(v));
  const local = new Int32Array(vertexCount).fill(-1);
  interior.forEach((v, i) => (local[v] = i));
  const n = interior.length;
  // the undirected edges once
  const ends: number[] = [];
  const done = new Set<number>();
  for (const f of faces)
    for (let k = 0; k < 3; k++) {
      const a = mesh.indices[3 * f + k] as number;
      const b = mesh.indices[3 * f + ((k + 1) % 3)] as number;
      const key = Math.min(a, b) * vertexCount + Math.max(a, b);
      if (done.has(key)) continue;
      done.add(key);
      ends.push(a, b);
    }
  const degree = new Int32Array(n + 1);
  for (let e = 0; e < ends.length; e += 2) {
    const [i, j] = [local[ends[e] as number] as number, local[ends[e + 1] as number] as number];
    if (i >= 0 && j >= 0) {
      degree[i + 1] = (degree[i + 1] as number) + 1;
      degree[j + 1] = (degree[j + 1] as number) + 1;
    }
  }
  const rowStart = new Int32Array(n + 1);
  for (let i = 0; i < n; i++) rowStart[i + 1] = (rowStart[i] as number) + (degree[i + 1] as number);
  const [cols, vals] = [new Int32Array(rowStart[n] as number), new Float64Array(rowStart[n] as number)];
  const fill = Int32Array.from(rowStart.subarray(0, n));
  const diagonal = new Float64Array(n);
  const [rhsU, rhsV] = [new Float64Array(n), new Float64Array(n)];
  for (let e = 0; e < ends.length; e += 2) {
    const [a, b] = [ends[e] as number, ends[e + 1] as number];
    for (const [v, other] of [
      [a, b],
      [b, a],
    ] as const) {
      const i = local[v] as number;
      if (i < 0) continue;
      const w = weight(v, other);
      diagonal[i] = (diagonal[i] as number) + w;
      const j = local[other] as number;
      if (j >= 0) {
        const at = fill[i] as number;
        cols[at] = j;
        vals[at] = w;
        fill[i] = at + 1;
      } else {
        const [u, t] = boundaryUv.get(other) as [number, number];
        rhsU[i] = (rhsU[i] as number) + w * u;
        rhsV[i] = (rhsV[i] as number) + w * t;
      }
    }
  }
  return { interior, diagonal, rowStart, cols, vals, rhsU, rhsV };
}

interface Solved {
  readonly uv: Map<number, [number, number]>;
  readonly u: Float64Array;
  readonly v: Float64Array;
  readonly iterations: number;
  readonly residual: number;
  readonly converged: boolean;
}

/** Solves for u and v; `symmetric` systems by conjugate gradient, the others by BiCGSTAB; `start` the first guess (0.5 when absent). */
function solve(
  system: System,
  boundaryUv: Map<number, [number, number]>,
  symmetric: boolean,
  budget: number,
  start?: { u: Float64Array; v: Float64Array },
): Solved {
  const n = system.interior.length;
  const { diagonal, rowStart, cols, vals } = system;
  const apply = (x: Float64Array, out: Float64Array): void => {
    for (let i = 0; i < n; i++) {
      let sum = (diagonal[i] as number) * (x[i] as number);
      for (let at = rowStart[i] as number; at < (rowStart[i + 1] as number); at++)
        sum -= (vals[at] as number) * (x[cols[at] as number] as number);
      out[i] = sum;
    }
  };
  const options = { maxIterations: budget, tolerance: HARMONIC_TOLERANCE, diagonal, stallWindow: STALL_WINDOW };
  const method = symmetric ? conjugateGradient : biCgStab;
  const guess = (): Float64Array => new Float64Array(n).fill(0.5);
  const [u, v] = [method(apply, system.rhsU, start?.u ?? guess(), options), method(apply, system.rhsV, start?.v ?? guess(), options)];
  const uv = new Map(boundaryUv);
  system.interior.forEach((vertex, i) => uv.set(vertex, [u.x[i] as number, v.x[i] as number]));
  return {
    uv,
    u: u.x,
    v: v.x,
    iterations: u.iterations + v.iterations,
    residual: Math.max(u.relativeResidual, v.relativeResidual),
    converged: u.converged && v.converged && [...uv.values()].every(([p, q]) => Number.isFinite(p) && Number.isFinite(q)),
  };
}

/** Triangles of the region with a negative (flipped) and a zero parameter area. */
function flips(mesh: MeshData, faces: ReadonlyArray<number>, uv: Map<number, [number, number]>): { flipped: number; collapsed: number } {
  let [flipped, collapsed] = [0, 0];
  for (const f of faces) {
    const [a, b, c] = [0, 1, 2].map((k) => uv.get(mesh.indices[3 * f + k] as number) as [number, number]) as [
      [number, number],
      [number, number],
      [number, number],
    ];
    const area = ((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) / 2;
    if (area < FLIP_AREA) flipped++;
    else if (area <= -FLIP_AREA) collapsed++;
  }
  return { flipped, collapsed };
}

/**
 * Harmonic map of the region `faces` of `mesh` onto the unit square.
 * @failure not one connected consistently wound manifold with one boundary loop of 4 vertices or more and Euler characteristic 1, or a triangle listed twice -> MESH_FIT_NOT_DISK;
 *   a solve that does not reach the tolerance within its iteration budget (or stalls), or a triangle still flipped with the mean-value weights -> MESH_FIT_PARAM_FOLDED
 */
export function harmonicMap(mesh: MeshData, faces: ReadonlyArray<number>, options: HarmonicOptions = {}): HarmonicMap | HarmonicRefusal {
  if (faces.length === 0) return notDisk('the region has no triangle');
  const topology = diskTopology(mesh, faces);
  if ('code' in topology) return topology;
  const point = pointOf(mesh);
  const { loop } = topology;
  const lengths = loop.map((v, i) => Math.hypot(...sub(point(loop[(i + 1) % loop.length] as number), point(v))));
  const perimeter = lengths.reduce((sum, length) => sum + length, 0);
  if (!(perimeter > 0)) return notDisk('the boundary loop of the region has no length');
  const arc: number[] = [];
  lengths.reduce((sum, length) => (arc.push(sum), sum + length), 0);
  const corners = pickCorners(loop, point, arc, perimeter);
  const boundaryUv = new Map<number, [number, number]>();
  corners.forEach((start, side) => {
    const end = side === 3 ? (corners[0] as number) + loop.length : (corners[side + 1] as number);
    const [from, to] = [arc[start] as number, end >= loop.length ? perimeter + (arc[end - loop.length] as number) : (arc[end] as number)];
    for (let i = start; i < end; i++) {
      const at = i % loop.length;
      const here = i >= loop.length ? perimeter + (arc[at] as number) : (arc[at] as number);
      boundaryUv.set(loop[at] as number, onSide(side, to > from ? (here - from) / (to - from) : 0));
    }
  });
  const vertexCount = mesh.positions.length / 3;
  const cotangent = cotangentWeights(mesh, faces);
  const key = (a: number, b: number): number => Math.min(a, b) * vertexCount + Math.max(a, b);
  const budget = options.maxIterations ?? iterationBudget(topology.vertices.length - loop.length);
  const first = solve(
    systemOf(mesh, faces, topology, (i, j) => cotangent.get(key(i, j)) ?? 0, boundaryUv),
    boundaryUv,
    true,
    budget,
  );
  const firstFlips = first.converged ? flips(mesh, faces, first.uv) : { flipped: faces.length, collapsed: 0 };
  const accept = (
    solved: Solved,
    weights: HarmonicMap['weights'],
    counted: { flipped: number; collapsed: number },
    flippedFirst: number,
  ): HarmonicMap => ({
    uv: solved.uv,
    weights,
    flippedFirst,
    collapsedInParameters: counted.collapsed,
    interiorVertices: topology.vertices.length - loop.length,
    boundaryVertices: loop.length,
    cgIterations: solved.iterations,
    cgResidual: solved.residual,
    corners: corners.map((c) => loop[c] as number) as unknown as HarmonicMap['corners'],
  });
  if (first.converged && firstFlips.flipped === 0) return accept(first, 'cotangent', firstFlips, 0);
  const meanValue = meanValueWeights(mesh, faces);
  const second = solve(
    systemOf(mesh, faces, topology, (i, j) => meanValue.get(i * vertexCount + j) ?? 0, boundaryUv),
    boundaryUv,
    false,
    budget,
    first.converged ? { u: first.u, v: first.v } : undefined,
  );
  if (!second.converged)
    return {
      code: 'MESH_FIT_PARAM_FOLDED',
      message: `the harmonic map did not reach its tolerance within the iteration budget (relative residual ${second.residual.toExponential(2)} against ${HARMONIC_TOLERANCE} after ${second.iterations} iterations, budget ${budget} per coordinate): the region's triangles are too degenerate or too many; decimate_mesh it, or pick a smaller region (faceGroups)`,
    };
  const secondFlips = flips(mesh, faces, second.uv);
  if (secondFlips.flipped > 0)
    return {
      code: 'MESH_FIT_PARAM_FOLDED',
      message: `${secondFlips.flipped} of ${faces.length} triangles are flipped in the parameter square even with mean-value weights (the exact cotangent weights flipped ${firstFlips.flipped}): the region has degenerate or overlapping triangles; repair_mesh it first`,
    };
  return accept(second, 'mean_value', secondFlips, firstFlips.flipped);
}

/**
 * Mean lengths of the surface derivatives per unit of u and of v over the region (area-weighted in the parameter square): the real size of the square along its two directions,
 * which decides the long axis and the aspect of the pole grid. Triangles with no parameter area are skipped.
 */
export function parameterStretch(
  mesh: MeshData,
  faces: ReadonlyArray<number>,
  uv: Map<number, [number, number]>,
): { u: number; v: number } {
  const point = pointOf(mesh);
  let [u, v, weight] = [0, 0, 0];
  for (const f of faces) {
    const [ia, ib, ic] = [0, 1, 2].map((k) => mesh.indices[3 * f + k] as number) as [number, number, number];
    const [a, b, c] = [uv.get(ia), uv.get(ib), uv.get(ic)] as [[number, number], [number, number], [number, number]];
    const [du1, dv1, du2, dv2] = [b[0] - a[0], b[1] - a[1], c[0] - a[0], c[1] - a[1]];
    const det = du1 * dv2 - du2 * dv1;
    if (!(Math.abs(det) > 1e-18)) continue;
    const [e1, e2] = [sub(point(ib), point(ia)), sub(point(ic), point(ia))];
    // P = e1 s + e2 t with (s, t) the barycentric inverse of the parameter triangle: dP/du = (e1 dv2 - e2 dv1) / det, dP/dv = (e2 du1 - e1 du2) / det
    const pu: Vec3 = [
      ((e1[0] as number) * dv2 - (e2[0] as number) * dv1) / det,
      ((e1[1] as number) * dv2 - (e2[1] as number) * dv1) / det,
      ((e1[2] as number) * dv2 - (e2[2] as number) * dv1) / det,
    ];
    const pv: Vec3 = [
      ((e2[0] as number) * du1 - (e1[0] as number) * du2) / det,
      ((e2[1] as number) * du1 - (e1[1] as number) * du2) / det,
      ((e2[2] as number) * du1 - (e1[2] as number) * du2) / det,
    ];
    const w = Math.abs(det);
    u += w * Math.hypot(...pu);
    v += w * Math.hypot(...pv);
    weight += w;
  }
  return weight > 0 ? { u: u / weight, v: v / weight } : { u: 1, v: 1 };
}
