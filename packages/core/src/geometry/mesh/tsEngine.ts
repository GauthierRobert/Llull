/** Default TypeScript mesh engine: analysis, convex hull, convex Minkowski sum, normal offset, midpoint / Loop subdivision. Exact doubles, no dependencies. */

import type { MeshData } from '../../model/types';
import type { Vec3 } from '../../model/vectors';
import { analyzeIndexedMesh } from './analysis';
import {
  MESH_HULL_POINT_LIMIT,
  MESH_TS_TRIANGLE_CAP,
  type MeshEngineFailure,
  type MeshInput,
  type MeshOp,
  type MeshOpName,
  type MeshOpResult,
  type MeshProcessingEngine,
  type MeshProvenance,
} from './engineTypes';
import { ANALYZE_DESCRIPTION } from './editable';
import { convexHull } from './hull';
import { findSelfIntersections } from './selfIntersection';
import { subdivideMesh } from './subdivide';
import { EDIT_OPS, runEditOp } from './tsEngineEdit';
import { weldMesh } from './weld';

const TS_VERSION = 'llull-ts-1';

const provenance = (algorithm: string, reference: string): MeshProvenance => ({
  engine: 'ts',
  version: TS_VERSION,
  algorithm,
  reference,
  deterministic: true,
});

const failure = (code: string, message: string): MeshEngineFailure => ({ code, message });

/** Volume of a closed outward-wound mesh (positive when outward). */
function signedVolume(positions: ReadonlyArray<number>, triangles: ReadonlyArray<number>): number {
  let sum = 0;
  for (let f = 0; f + 2 < triangles.length; f += 3) {
    const [a, b, c] = [triangles[f] as number, triangles[f + 1] as number, triangles[f + 2] as number];
    const p = (i: number): Vec3 => [positions[i * 3] as number, positions[i * 3 + 1] as number, positions[i * 3 + 2] as number];
    const [pa, pb, pc] = [p(a), p(b), p(c)];
    sum += pa[0] * (pb[1] * pc[2] - pb[2] * pc[1]) - pa[1] * (pb[0] * pc[2] - pb[2] * pc[0]) + pa[2] * (pb[0] * pc[1] - pb[1] * pc[0]);
  }
  return sum / 6;
}

/** True when `mesh` is a closed convex polyhedron: it equals the hull of its own vertices. */
function isConvex(mesh: MeshData): boolean {
  const hull = convexHull(mesh.positions);
  if (hull === null) return false;
  const own = Math.abs(signedVolume(mesh.positions, mesh.indices));
  const hulled = signedVolume(hull.positions, hull.triangles);
  return hulled > 0 && Math.abs(hulled - own) <= 1e-9 * hulled;
}

/** Pairs a_i + b_j above which the convex path hands over to another engine. */
const MAX_SUM_POINTS = 2_000_000;

function minkowskiSum(a: MeshData, b: MeshData): MeshOpResult | MeshEngineFailure {
  const uniqueA = weldMesh(a, 0).positions;
  const uniqueB = weldMesh(b, 0).positions;
  if (!isConvex(a) || !isConvex(b)) return failure('MESH_ENGINE_UNSUPPORTED', 'the TypeScript engine sums convex meshes only');
  const count = (uniqueA.length / 3) * (uniqueB.length / 3);
  if (count > MAX_SUM_POINTS)
    return failure('MESH_ENGINE_UNSUPPORTED', `${count} vertex sums exceed the TypeScript limit of ${MAX_SUM_POINTS}`);
  const sums: number[] = [];
  for (let i = 0; i < uniqueA.length; i += 3) {
    for (let j = 0; j < uniqueB.length; j += 3)
      sums.push(
        (uniqueA[i] as number) + (uniqueB[j] as number),
        (uniqueA[i + 1] as number) + (uniqueB[j + 1] as number),
        (uniqueA[i + 2] as number) + (uniqueB[j + 2] as number),
      );
  }
  const hull = convexHull(sums);
  if (hull === null) return failure('MESH_HULL_DEGENERATE', 'the Minkowski sum is flat');
  return {
    mesh: { positions: hull.positions, indices: hull.triangles },
    report: { pairs: count, hullVertices: hull.positions.length / 3, hullTriangles: hull.triangles.length / 3 },
    provenance: provenance('convex Minkowski sum = hull of all vertex sums a_i + b_j', 'de Berg et al., Computational Geometry, ch. 13'),
  };
}

/** Angle-weighted vertex normals of a welded mesh. */
function vertexNormals(positions: ReadonlyArray<number>, triangles: ReadonlyArray<number>): number[] {
  const normals = new Array<number>(positions.length).fill(0);
  const p = (i: number): Vec3 => [positions[i * 3] as number, positions[i * 3 + 1] as number, positions[i * 3 + 2] as number];
  for (let f = 0; f + 2 < triangles.length; f += 3) {
    const ids = [triangles[f] as number, triangles[f + 1] as number, triangles[f + 2] as number];
    const pts = ids.map(p) as [Vec3, Vec3, Vec3];
    const n: Vec3 = [
      (pts[1][1] - pts[0][1]) * (pts[2][2] - pts[0][2]) - (pts[1][2] - pts[0][2]) * (pts[2][1] - pts[0][1]),
      (pts[1][2] - pts[0][2]) * (pts[2][0] - pts[0][0]) - (pts[1][0] - pts[0][0]) * (pts[2][2] - pts[0][2]),
      (pts[1][0] - pts[0][0]) * (pts[2][1] - pts[0][1]) - (pts[1][1] - pts[0][1]) * (pts[2][0] - pts[0][0]),
    ];
    const length = Math.hypot(...n);
    if (length === 0) continue;
    for (let k = 0; k < 3; k++) {
      const [u, v]: [Vec3, Vec3] = [pts[(k + 1) % 3] as Vec3, pts[(k + 2) % 3] as Vec3];
      const o = pts[k] as Vec3;
      const e1: Vec3 = [u[0] - o[0], u[1] - o[1], u[2] - o[2]];
      const e2: Vec3 = [v[0] - o[0], v[1] - o[1], v[2] - o[2]];
      const cosine = (e1[0] * e2[0] + e1[1] * e2[1] + e1[2] * e2[2]) / (Math.hypot(...e1) * Math.hypot(...e2) || 1);
      const angle = Math.acos(Math.max(-1, Math.min(1, cosine)));
      for (let axis = 0; axis < 3; axis++)
        normals[(ids[k] as number) * 3 + axis] =
          (normals[(ids[k] as number) * 3 + axis] as number) + (angle * (n[axis] as number)) / length;
    }
  }
  return normals;
}

function normalOffset(mesh: MeshData, distance: number): MeshOpResult {
  const welded = weldMesh(mesh, 0);
  const normals = vertexNormals(welded.positions, welded.triangles);
  const positions = welded.positions.map((value, i) => {
    const vertex = Math.floor(i / 3) * 3;
    const length = Math.hypot(normals[vertex] as number, normals[vertex + 1] as number, normals[vertex + 2] as number);
    return length > 0 ? value + (distance * (normals[i] as number)) / length : value;
  });
  const crossings = findSelfIntersections(positions, welded.triangles, 0).count;
  return {
    mesh: { positions, indices: welded.triangles },
    report: { selfIntersectionsCreated: crossings },
    provenance: provenance('vertex-normal offset x_i + d n_i (angle-weighted normals)', 'standard vertex-normal displacement'),
  };
}

function run(input: MeshInput, op: MeshOp): MeshOpResult | MeshEngineFailure {
  switch (op.op) {
    case 'analyze': {
      const welded = weldMesh(input.mesh, op.weldTolerance);
      return {
        analysis: analyzeIndexedMesh(welded.positions, welded.triangles, {
          selfIntersections: op.selfIntersections,
          maxListed: op.maxListed,
        }),
        report: { weldTolerance: op.weldTolerance, mergedVertices: welded.mergedVertices },
        provenance: provenance(ANALYZE_DESCRIPTION.algorithm, ANALYZE_DESCRIPTION.reference),
      };
    }
    case 'hull': {
      const hull = convexHull(op.points);
      if (hull === null) return failure('MESH_HULL_DEGENERATE', 'fewer than 4 non-coplanar points');
      return {
        mesh: { positions: hull.positions, indices: hull.triangles },
        report: { vertices: hull.positions.length / 3, faces: hull.triangles.length / 3 },
        provenance: provenance('quickhull, coplanar merge at 1e-12 x diameter', 'Barber, Dobkin, Huhdanpaa 1996'),
      };
    }
    case 'minkowski':
      return op.kind === 'sum'
        ? minkowskiSum(input.mesh, op.other.mesh)
        : failure('MESH_ENGINE_UNSUPPORTED', 'Minkowski difference needs the Manifold engine');
    case 'offset':
      return op.method === 'normal'
        ? normalOffset(input.mesh, op.distance)
        : failure('MESH_ENGINE_UNSUPPORTED', 'level-set offset needs the Manifold engine');
    case 'subdivide': {
      if (op.method === 'smooth') return failure('MESH_ENGINE_UNSUPPORTED', 'smooth subdivision needs the Manifold engine');
      const welded = weldMesh(input.mesh, 0);
      const result = subdivideMesh({ positions: welded.positions, triangles: welded.triangles }, op.method, op.levels);
      return {
        mesh: { positions: result.positions, indices: result.triangles },
        report: { levels: op.levels, faces: result.triangles.length / 3 },
        provenance: provenance(
          op.method === 'midpoint' ? 'linear midpoint subdivision (1 to 4)' : 'Loop subdivision',
          op.method === 'midpoint' ? 'linear subdivision keeps the geometry' : 'Loop 1987',
        ),
      };
    }
    case 'repair':
    case 'fill_holes':
    case 'decimate':
    case 'remesh':
    case 'smooth':
    case 'cut':
    case 'deviation':
    case 'segment':
    case 'sculpt':
      return runEditOp(input, op);
    default:
      return failure('MESH_ENGINE_UNSUPPORTED', `the TypeScript engine does not answer "${op.op}"`);
  }
}

const CAPABILITIES: ReadonlyMap<MeshOpName, number> = new Map<MeshOpName, number>([
  ['analyze', MESH_TS_TRIANGLE_CAP],
  ['hull', MESH_HULL_POINT_LIMIT],
  ['minkowski', MESH_TS_TRIANGLE_CAP],
  ['offset', MESH_TS_TRIANGLE_CAP],
  ['subdivide', MESH_TS_TRIANGLE_CAP],
  ...EDIT_OPS.map((name): [MeshOpName, number] => [name, MESH_TS_TRIANGLE_CAP]),
]);

export const tsMeshEngine: MeshProcessingEngine = { name: 'ts', capabilities: () => CAPABILITIES, run };
