/** Maps 05 targets (points near faces / edges / points of a part) onto the nodes of the voxel grid (TECHNICAL_SPEC 5.4). */

import type { TopologyTarget } from '@core/model/topology';
import type { Triangle } from '@core/geometry/triangles';
import { closestPointOnTriangle, closestPointsOfSegments } from '@core/geometry/triangleQueries';
import type { Vec3 } from '@core/model/types';
import { cross3, distance3, dot3, len3, normalize3, sub3 } from '@lib/vec3';
import { projectOntoSegment } from '@lib/polygon';
import { quantizedKey } from '@lib/quantize';
import { nodePosition, type TopologyGrid } from './voxel';

/** Node (i, j, k) -> index; dof c of node n is `components * n + c`. */
const nodeIndex = (grid: TopologyGrid, i: number, j: number, k: number): number => i + (grid.nx + 1) * (j + (grid.ny + 1) * k);

export const dofComponents = (grid: TopologyGrid): number => grid.dimension;

interface NodeSets {
  /** Nodes touching at least one active voxel. */
  readonly used: number[];
  /** Used nodes that also touch an inactive voxel or the outside of the grid. */
  readonly boundary: number[];
}

/** Used and boundary nodes of the active voxels (ascending node index). */
export function nodeSets(grid: TopologyGrid, active: Uint8Array): NodeSets {
  const layers = grid.dimension === 2 ? 1 : grid.nz + 1;
  const used: number[] = [];
  const boundary: number[] = [];
  const voxelsPerNode = grid.dimension === 2 ? 4 : 8;
  for (let k = 0; k < layers; k += 1)
    for (let j = 0; j <= grid.ny; j += 1)
      for (let i = 0; i <= grid.nx; i += 1) {
        let activeNeighbours = 0;
        for (let dk = grid.dimension === 2 ? 0 : -1; dk <= 0; dk += 1)
          for (let dj = -1; dj <= 0; dj += 1)
            for (let di = -1; di <= 0; di += 1) {
              const vi = i + di;
              const vj = j + dj;
              const vk = grid.dimension === 2 ? 0 : k + dk;
              const inside = vi >= 0 && vj >= 0 && vk >= 0 && vi < grid.nx && vj < grid.ny && vk < grid.nz;
              if (inside && active[vi + grid.nx * (vj + grid.ny * vk)] === 1) activeNeighbours += 1;
            }
        const index = nodeIndex(grid, i, j, k);
        if (activeNeighbours > 0) used.push(index);
        if (activeNeighbours > 0 && activeNeighbours < voxelsPerNode) boundary.push(index);
      }
  return { used, boundary };
}

/** Grid coordinates (i, j, k) of node `index`. */
export function nodeCoordinates(grid: TopologyGrid, index: number): [number, number, number] {
  const perLayer = (grid.nx + 1) * (grid.ny + 1);
  const k = Math.floor(index / perLayer);
  const rest = index - k * perLayer;
  const j = Math.floor(rest / (grid.nx + 1));
  return [rest - j * (grid.nx + 1), j, k];
}

const position = (grid: TopologyGrid, index: number): Vec3 => nodePosition(grid, ...nodeCoordinates(grid, index));

/** Flat view of a surface: a 2D grid measures distances in the plane of the grid (the out-of-plane coordinate is dropped). */
const flatten = (grid: TopologyGrid, point: Vec3): Vec3 => {
  if (grid.dimension === 3) return point;
  const flat: [number, number, number] = [point[0], point[1], point[2]];
  flat[grid.axes[2]] = 0;
  return flat;
};

function distanceToTriangle(grid: TopologyGrid, point: Vec3, triangle: Triangle): number {
  if (grid.dimension === 3) return distance3(point, closestPointOnTriangle(point, triangle));
  const [ai, aj] = grid.axes;
  const plane = (p: Vec3): [number, number] => [p[ai] ?? 0, p[aj] ?? 0];
  const q = plane(point);
  const [a, b, c] = triangle.map(plane) as [[number, number], [number, number], [number, number]];
  const area = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const side = (p: [number, number], s: [number, number], t: [number, number]): number =>
    (t[0] - s[0]) * (p[1] - s[1]) - (t[1] - s[1]) * (p[0] - s[0]);
  if (Math.abs(area) > 1e-18 && [side(q, a, b), side(q, b, c), side(q, c, a)].every((value) => value * area >= 0)) return 0;
  return Math.min(projectOntoSegment(q, a, b).distance, projectOntoSegment(q, b, c).distance, projectOntoSegment(q, c, a).distance);
}

function distanceToSegment(grid: TopologyGrid, point: Vec3, a: Vec3, b: Vec3): number {
  if (grid.dimension === 3) return closestPointsOfSegments(point, point, a, b).distance;
  const [ai, aj] = grid.axes;
  return projectOntoSegment([point[ai] ?? 0, point[aj] ?? 0], [a[ai] ?? 0, a[aj] ?? 0], [b[ai] ?? 0, b[aj] ?? 0]).distance;
}

const normalOf = ([a, b, c]: Triangle): Vec3 => normalize3(cross3(sub3(b, a), sub3(c, a)));
const VERTEX_UNIT = 1e-6;
const scaleOf = (triangles: readonly Triangle[]): number =>
  Math.max(1e-12, ...triangles.flatMap((t) => t.map((p) => Math.max(...p.map(Math.abs)))));

/** Triangles coplanar with `seed` that are connected to it through shared vertices. */
function planarGroup(triangles: readonly Triangle[], seed: number): number[] {
  const seedNormal = normalOf(triangles[seed] as Triangle);
  const seedPoint = (triangles[seed] as Triangle)[0];
  const tolerance = 1e-7 * scaleOf(triangles);
  const byVertex = new Map<string, number[]>();
  triangles.forEach((triangle, index) =>
    triangle.forEach((p) => byVertex.set(quantizedKey(p, VERTEX_UNIT), [...(byVertex.get(quantizedKey(p, VERTEX_UNIT)) ?? []), index])),
  );
  const coplanar = (index: number): boolean => {
    const triangle = triangles[index] as Triangle;
    return dot3(normalOf(triangle), seedNormal) > 1 - 1e-9 && Math.abs(dot3(sub3(triangle[0], seedPoint), seedNormal)) < tolerance;
  };
  const group = new Set<number>([seed]);
  const queue = [seed];
  while (queue.length > 0) {
    const current = queue.shift() as number;
    for (const p of triangles[current] as Triangle)
      for (const next of byVertex.get(quantizedKey(p, VERTEX_UNIT)) ?? [])
        if (!group.has(next) && coplanar(next)) {
          group.add(next);
          queue.push(next);
        }
  }
  return [...group].sort((a, b) => a - b);
}

interface Edge {
  readonly a: Vec3;
  readonly b: Vec3;
}

/** Feature edges: boundary edges and edges between triangles whose normals differ. */
function featureEdges(triangles: readonly Triangle[]): Edge[] {
  const edges = new Map<string, { edge: Edge; normals: Vec3[] }>();
  for (const triangle of triangles) {
    const normal = normalOf(triangle);
    for (let i = 0; i < 3; i += 1) {
      const a = triangle[i] as Vec3;
      const b = triangle[(i + 1) % 3] as Vec3;
      const [ka, kb] = [quantizedKey(a, VERTEX_UNIT), quantizedKey(b, VERTEX_UNIT)];
      const key = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
      const entry = edges.get(key) ?? { edge: { a, b }, normals: [] };
      entry.normals.push(normal);
      edges.set(key, entry);
    }
  }
  return [...edges.values()]
    .filter(({ normals }) => normals.length === 1 || normals.some((normal) => dot3(normal, normals[0] as Vec3) < 1 - 1e-6))
    .map(({ edge }) => edge);
}

const direction = ({ a, b }: Edge): Vec3 => normalize3(sub3(b, a));
const collinear = (edge: Edge, other: Edge, tolerance: number): boolean =>
  len3(cross3(direction(edge), direction(other))) < 1e-6 && len3(cross3(sub3(other.a, edge.a), direction(edge))) < tolerance;

/** The nearest feature edge to `point` and every feature edge collinear with it and connected to it. */
function edgeChain(grid: TopologyGrid, triangles: readonly Triangle[], point: Vec3): Edge[] {
  const edges = featureEdges(triangles);
  if (edges.length === 0) return [];
  const distances = edges.map((edge) => distanceToSegment(grid, point, edge.a, edge.b));
  const seed = edges[distances.indexOf(Math.min(...distances))] as Edge;
  const tolerance = 1e-7 * scaleOf(triangles);
  const line = edges.filter((edge) => collinear(seed, edge, tolerance));
  const chain = new Set<Edge>([seed]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const edge of line)
      if (
        !chain.has(edge) &&
        [...chain].some((member) => [member.a, member.b].some((p) => [edge.a, edge.b].some((q) => distance3(p, q) < tolerance)))
      ) {
        chain.add(edge);
        grew = true;
      }
  }
  return [...chain];
}

export interface MappedTarget {
  readonly nodes: number[];
  /** Unit normal of the first face selector (outward), when the target has one. */
  readonly normal?: Vec3;
  /** Area of the planar faces selected by `facesNear` (document units squared), when the target has any. */
  readonly faceArea?: number;
}

const triangleArea = ([a, b, c]: Triangle): number => len3(cross3(sub3(b, a), sub3(c, a))) / 2;

export interface MappingFailure {
  readonly error: string;
}

/**
 * Grid nodes of a target: `pointsNear` -> the nearest used node of each point; `facesNear` -> boundary nodes within half a voxel of the
 * planar face nearest to each point; `edgesNear` -> boundary nodes within half a voxel of the feature edge nearest to each point.
 * @param triangles world-space triangles of the target entity
 * @failure a selector that maps to no node, or a face target of a 2D grid that is parallel to the plane -> `{ error }`
 */
export function mapTarget(
  grid: TopologyGrid,
  sets: NodeSets,
  triangles: readonly Triangle[],
  target: TopologyTarget,
): MappedTarget | MappingFailure {
  const found = new Set<number>();
  let normal: Vec3 | undefined;
  let faceArea: number | undefined;
  const reach = grid.voxel / 2 + 1e-9 * grid.voxel;
  const near = (index: number, distanceOf: (p: Vec3) => number): boolean => distanceOf(position(grid, index)) <= reach;
  for (const point of target.pointsNear ?? []) {
    const flat = flatten(grid, point);
    const distances = sets.used.map((index) => distance3(flatten(grid, position(grid, index)), flat));
    const best = Math.min(...distances);
    if (!(best <= 1.5 * grid.voxel * Math.sqrt(grid.dimension)))
      return { error: `point [${point.join(', ')}] is ${best} from the nearest node of the domain` };
    found.add(sets.used[distances.indexOf(best)] as number);
  }
  for (const point of target.facesNear ?? []) {
    const exact = triangles.map((triangle) => distance3(point, closestPointOnTriangle(point, triangle)));
    const nearest = Math.min(...exact);
    const tie = nearest + 1e-9 * scaleOf(triangles);
    const candidates = triangles.map((triangle, index) => ({ triangle, index })).filter(({ index }) => (exact[index] ?? Infinity) <= tie);
    const sides =
      grid.dimension === 3 ? candidates : candidates.filter(({ triangle }) => Math.abs(normalOf(triangle)[grid.axes[2]] ?? 0) < 0.5);
    if (sides.length === 0) return { error: `the face nearest to [${point.join(', ')}] is parallel to the plane of the 2D grid` };
    const seed = sides[0]?.index ?? 0;
    const group = planarGroup(triangles, seed).map((index) => triangles[index] as Triangle);
    normal ??= normalOf(triangles[seed] as Triangle);
    faceArea = (faceArea ?? 0) + group.reduce((total, triangle) => total + triangleArea(triangle), 0);
    const before = found.size;
    for (const index of sets.boundary)
      if (near(index, (p) => Math.min(...group.map((t) => distanceToTriangle(grid, p, t))))) found.add(index);
    if (found.size === before) return { error: `no domain node lies on the face nearest to [${point.join(', ')}]` };
  }
  for (const point of target.edgesNear ?? []) {
    const chain = edgeChain(grid, triangles, point);
    const before = found.size;
    for (const index of sets.boundary)
      if (near(index, (p) => Math.min(...chain.map((e) => distanceToSegment(grid, p, e.a, e.b))))) found.add(index);
    if (found.size === before) return { error: `no domain node lies on the edge nearest to [${point.join(', ')}]` };
  }
  return {
    nodes: [...found].sort((a, b) => a - b),
    ...(normal !== undefined ? { normal } : {}),
    ...(faceArea !== undefined ? { faceArea } : {}),
  };
}

export const isMappingFailure = (value: MappedTarget | MappingFailure): value is MappingFailure => 'error' in value;
