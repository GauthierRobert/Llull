/**
 * Harmonic-map parameterisation of a disk-topology region of a triangle mesh (07 MSH FR-MSH-24, TECHNICAL_SPEC 13.23): the boundary loop goes onto the boundary of the unit
 * parameter square by arc length (the quarter points of its length are the corners), every interior vertex is the weighted mean of its neighbours (the discrete Laplace
 * equation with the cotangent weights, solved by Jacobi-preconditioned conjugate gradient), and a result with a flipped triangle is solved again with clamped positive weights
 * (Tutte / Floater: positive symmetric weights and a convex boundary give an embedding) before the region is refused.
 * @invariant the region needs one connected, manifold, consistently wound surface with exactly one boundary loop and Euler characteristic 1; the parameters of the boundary
 *   run counter-clockwise when the triangles face the viewer, so du x dv follows the triangle normals
 */

import { conjugateGradient } from '../../lib/conjugateGradient';
import type { MeshData } from '../../model/types';
import type { Vec3 } from '../../model/vectors';

export interface HarmonicMap {
  /** Parameters (u, v) in [0, 1] of every vertex of the region, by mesh vertex index. */
  readonly uv: Map<number, [number, number]>;
  /** The weights of the accepted solve: the exact cotangent weights, or the same clamped to a positive floor after the exact ones flipped a triangle. */
  readonly weights: 'cotangent' | 'cotangent_clamped';
  /** Triangles of the exact-cotangent solve whose parameter triangle had a negative area (0 when its result was accepted). */
  readonly flippedFirst: number;
  /** Triangles whose parameter triangle has no area (all three vertices on one side of the square): not flipped, counted. */
  readonly collapsedInParameters: number;
  readonly interiorVertices: number;
  readonly boundaryVertices: number;
  /** Conjugate gradient iterations of the accepted solve (u and v together) and the worst final relative residual. */
  readonly cgIterations: number;
  readonly cgResidual: number;
}

export interface HarmonicRefusal {
  readonly code: 'MESH_FIT_NOT_DISK' | 'MESH_FIT_PARAM_FOLDED';
  readonly message: string;
}

/** Relative residual of the conjugate gradient solves. */
const HARMONIC_TOLERANCE = 1e-10;
/** A parameter triangle with a signed area below minus this (the square has area 1) is flipped. */
const FLIP_AREA = -1e-12;
/** The clamped weights are at least this share of the mean absolute cotangent weight. */
const CLAMP_SHARE = 1e-3;

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

const notDisk = (message: string): HarmonicRefusal => ({ code: 'MESH_FIT_NOT_DISK', message });

/** Position on the boundary of the unit square (counter-clockwise from (0, 0)) at the share `t` of the perimeter. */
function onSquare(t: number): [number, number] {
  const p = 4 * t;
  const side = Math.min(3, Math.floor(p));
  const f = p - side;
  return side === 0 ? [f, 0] : side === 1 ? [1, f] : side === 2 ? [1 - f, 1] : [0, 1 - f];
}

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
  for (const f of faces) {
    for (let k = 0; k < 3; k++) {
      const a = mesh.indices[3 * f + k] as number;
      const b = mesh.indices[3 * f + ((k + 1) % 3)] as number;
      seen.add(a);
      if (a === b) return notDisk(`triangle ${f} has a repeated vertex`);
      const key = a * vertexCount + b;
      if (directed.has(key))
        return notDisk(
          `the region is not a consistently wound manifold: the edge ${a}-${b} is used twice in the same direction (triangle ${f})`,
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
  return { vertices, loop: loops[0] as number[], edges };
}

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

/** Cotangent weight of every undirected edge of the region (half the sum of the cotangents of the angles opposite it), keyed `min * vertexCount + max`. */
function cotangentWeights(mesh: MeshData, faces: ReadonlyArray<number>): Map<number, number> {
  const vertexCount = mesh.positions.length / 3;
  const point = (v: number): Vec3 => [
    mesh.positions[3 * v] as number,
    mesh.positions[3 * v + 1] as number,
    mesh.positions[3 * v + 2] as number,
  ];
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

function systemOf(
  mesh: MeshData,
  faces: ReadonlyArray<number>,
  topology: Topology,
  weight: (a: number, b: number) => number,
  boundaryUv: Map<number, [number, number]>,
): System {
  const vertexCount = mesh.positions.length / 3;
  const interior = topology.vertices.filter((v) => !boundaryUv.has(v));
  const local = new Int32Array(vertexCount).fill(-1);
  interior.forEach((v, i) => (local[v] = i));
  const n = interior.length;
  // the undirected edges once, with their weights
  const [ends, weights]: [number[], number[]] = [[], []];
  const done = new Set<number>();
  for (const f of faces)
    for (let k = 0; k < 3; k++) {
      const a = mesh.indices[3 * f + k] as number;
      const b = mesh.indices[3 * f + ((k + 1) % 3)] as number;
      const key = Math.min(a, b) * vertexCount + Math.max(a, b);
      if (done.has(key)) continue;
      done.add(key);
      ends.push(a, b);
      weights.push(weight(a, b));
    }
  const degree = new Int32Array(n + 1);
  for (let e = 0; e < weights.length; e++)
    for (const v of [ends[2 * e] as number, ends[2 * e + 1] as number]) {
      const other = v === ends[2 * e] ? (ends[2 * e + 1] as number) : (ends[2 * e] as number);
      const [i, j] = [local[v] as number, local[other] as number];
      if (i >= 0 && j >= 0) degree[i + 1] = (degree[i + 1] as number) + 1;
    }
  const rowStart = new Int32Array(n + 1);
  for (let i = 0; i < n; i++) rowStart[i + 1] = (rowStart[i] as number) + (degree[i + 1] as number);
  const [cols, vals] = [new Int32Array(rowStart[n] as number), new Float64Array(rowStart[n] as number)];
  const fill = Int32Array.from(rowStart.subarray(0, n));
  const diagonal = new Float64Array(n);
  const [rhsU, rhsV] = [new Float64Array(n), new Float64Array(n)];
  for (let e = 0; e < weights.length; e++) {
    const w = weights[e] as number;
    for (const [v, other] of [
      [ends[2 * e] as number, ends[2 * e + 1] as number],
      [ends[2 * e + 1] as number, ends[2 * e] as number],
    ] as const) {
      const i = local[v] as number;
      if (i < 0) continue;
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
  readonly iterations: number;
  readonly residual: number;
  readonly converged: boolean;
}

function solve(system: System, boundaryUv: Map<number, [number, number]>): Solved {
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
  const options = { maxIterations: Math.max(1000, 4 * n), tolerance: HARMONIC_TOLERANCE, diagonal };
  const start = new Float64Array(n).fill(0.5);
  const [u, v] = [conjugateGradient(apply, system.rhsU, start, options), conjugateGradient(apply, system.rhsV, start, options)];
  const uv = new Map(boundaryUv);
  system.interior.forEach((vertex, i) => uv.set(vertex, [u.x[i] as number, v.x[i] as number]));
  return {
    uv,
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
 * @failure not one connected consistently wound manifold with one boundary loop and Euler characteristic 1 -> MESH_FIT_NOT_DISK; a solve that does not converge, or a triangle still flipped with the clamped weights -> MESH_FIT_PARAM_FOLDED
 */
export function harmonicMap(mesh: MeshData, faces: ReadonlyArray<number>): HarmonicMap | HarmonicRefusal {
  if (faces.length === 0) return notDisk('the region has no triangle');
  const topology = diskTopology(mesh, faces);
  if ('code' in topology) return topology;
  const point = (v: number): Vec3 => [
    mesh.positions[3 * v] as number,
    mesh.positions[3 * v + 1] as number,
    mesh.positions[3 * v + 2] as number,
  ];
  const { loop } = topology;
  const lengths = loop.map((v, i) => Math.hypot(...sub(point(loop[(i + 1) % loop.length] as number), point(v))));
  const perimeter = lengths.reduce((sum, length) => sum + length, 0);
  if (!(perimeter > 0)) return notDisk('the boundary loop of the region has no length');
  const boundaryUv = new Map<number, [number, number]>();
  let along = 0;
  loop.forEach((v, i) => {
    boundaryUv.set(v, onSquare(along / perimeter));
    along += lengths[i] as number;
  });
  const cotangent = cotangentWeights(mesh, faces);
  const vertexCount = mesh.positions.length / 3;
  const key = (a: number, b: number): number => Math.min(a, b) * vertexCount + Math.max(a, b);
  const exact = (a: number, b: number): number => cotangent.get(key(a, b)) ?? 0;
  const mean = [...cotangent.values()].reduce((sum, w) => sum + Math.abs(w), 0) / Math.max(1, cotangent.size);
  const floor = CLAMP_SHARE * mean;
  const clamped = (a: number, b: number): number => Math.max(exact(a, b), floor);
  const first = solve(systemOf(mesh, faces, topology, exact, boundaryUv), boundaryUv);
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
  });
  if (first.converged && firstFlips.flipped === 0) return accept(first, 'cotangent', firstFlips, 0);
  const second = solve(systemOf(mesh, faces, topology, clamped, boundaryUv), boundaryUv);
  if (!second.converged)
    return {
      code: 'MESH_FIT_PARAM_FOLDED',
      message: `the harmonic map did not converge (relative residual ${second.residual.toExponential(2)} against ${HARMONIC_TOLERANCE}); the region's triangles are too degenerate`,
    };
  const secondFlips = flips(mesh, faces, second.uv);
  if (secondFlips.flipped > 0)
    return {
      code: 'MESH_FIT_PARAM_FOLDED',
      message: `${secondFlips.flipped} of ${faces.length} triangles are flipped in the parameter square even with positive weights (the exact cotangent weights flipped ${firstFlips.flipped}): the region has degenerate or overlapping triangles; repair_mesh it first`,
    };
  return accept(second, 'cotangent_clamped', secondFlips, firstFlips.flipped);
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
  const point = (v: number): Vec3 => [
    mesh.positions[3 * v] as number,
    mesh.positions[3 * v + 1] as number,
    mesh.positions[3 * v + 2] as number,
  ];
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
