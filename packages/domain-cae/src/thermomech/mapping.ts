/**
 * Mesh-to-mesh temperature mapping (PHY-04 TR-TMC-23): for each node of a target mesh, find the source element that contains it (bounding-box
 * tree, deterministic: the lowest element index wins) and interpolate the source nodal values with the element shape functions (C3D4 linear,
 * C3D10 quadratic; mid-edge nodes are taken at the straight-edge positions, which is how the mesher writes them). A node outside every element
 * is projected on the nearest element (flagged and counted); the largest distance moved is reported.
 */

import type { FeMeshArtifact } from '@core/model/analysis';
import { cross3, dot3, sub3 } from '@lib/vec3';
import { closestPointOnTriangle } from '@core/geometry/triangleQueries';

export interface MappingReport {
  /** Largest distance from a target node to the source element used (0 when all nodes are inside), in mesh length units. */
  readonly maxMappingDistance: number;
  /** Target nodes outside every source element (value taken at the nearest point of the nearest element). */
  readonly outside: number;
  /** Largest |mapped - source| at target nodes that coincide with a source node (the check of TR-TMC-23: must be < 1e-9). */
  readonly coincidentMaxError: number;
  readonly coincidentNodes: number;
}

export interface MappedField {
  readonly ok: true;
  readonly values: readonly number[];
  /** Source element used per target node (0-based index in block / element order) and the distance moved to it (0 inside). */
  readonly elements: readonly number[];
  readonly distances: readonly number[];
  readonly report: MappingReport;
}

export interface MappingRefusal {
  readonly ok: false;
  readonly message: string;
}

type Vec = readonly [number, number, number];

/** Barycentric slack that still counts as inside (a node on a shared face), and the distance below which two candidates tie. */
const INSIDE = 1e-9;
const TIE = 1e-15;

interface SourceElement {
  readonly nodes: readonly number[];
  /** Corner coordinates and the inverse of the barycentric matrix. */
  readonly corners: readonly [Vec, Vec, Vec, Vec];
  readonly low: Vec;
  readonly high: Vec;
}

interface Tree {
  readonly low: Vec;
  readonly high: Vec;
  readonly element?: number;
  readonly left?: Tree;
  readonly right?: Tree;
}

/** Barycentric coordinates of `p` in the tetrahedron `c` (null for a degenerate element). */
function barycentric(c: readonly [Vec, Vec, Vec, Vec], p: Vec): [number, number, number, number] | null {
  const a = sub3(c[1], c[0]);
  const b = sub3(c[2], c[0]);
  const d = sub3(c[3], c[0]);
  const det = dot3(a, cross3(b, d));
  if (!Number.isFinite(det) || Math.abs(det) < 1e-300) return null;
  const q = sub3(p, c[0]);
  const l1 = dot3(q, cross3(b, d)) / det;
  const l2 = dot3(a, cross3(q, d)) / det;
  const l3 = dot3(a, cross3(b, q)) / det;
  return [1 - l1 - l2 - l3, l1, l2, l3];
}

const FACES = [
  [0, 1, 2],
  [0, 3, 1],
  [1, 3, 2],
  [2, 3, 0],
] as const;

/** Closest point of the (closed) tetrahedron to p, and its distance. */
function closestOnTet(c: readonly [Vec, Vec, Vec, Vec], p: Vec): { readonly point: Vec; readonly distance: number } {
  const inside = barycentric(c, p);
  if (inside !== null && inside.every((l) => l >= -INSIDE)) return { point: p, distance: 0 };
  let best: Vec = c[0];
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const [i, j, k] of FACES) {
    const point = closestPointOnTriangle(p, [c[i as 0], c[j as 0], c[k as 0]]);
    const distance = Math.hypot(...sub3(p, point));
    if (distance < bestDistance) {
      best = point;
      bestDistance = distance;
    }
  }
  return { point: best, distance: bestDistance };
}

/** Shape functions of C3D4 (4 nodes) / C3D10 (10 nodes, CalculiX order) at barycentric coordinates. */
function shape(l: readonly [number, number, number, number], nodes: number): number[] {
  const [l1, l2, l3, l4] = l;
  if (nodes === 4) return [l1, l2, l3, l4];
  return [
    l1 * (2 * l1 - 1),
    l2 * (2 * l2 - 1),
    l3 * (2 * l3 - 1),
    l4 * (2 * l4 - 1),
    4 * l1 * l2,
    4 * l2 * l3,
    4 * l3 * l1,
    4 * l1 * l4,
    4 * l2 * l4,
    4 * l3 * l4,
  ];
}

function boxDistance(low: Vec, high: Vec, p: Vec): number {
  const d = [0, 1, 2].map((axis) => Math.max((low[axis] ?? 0) - (p[axis] ?? 0), 0, (p[axis] ?? 0) - (high[axis] ?? 0)));
  return Math.hypot(...d);
}

function build(elements: readonly SourceElement[], indices: readonly number[]): Tree {
  const first = indices[0] ?? 0;
  if (indices.length === 1) return { low: elements[first]?.low ?? [0, 0, 0], high: elements[first]?.high ?? [0, 0, 0], element: first };
  const low: [number, number, number] = [Infinity, Infinity, Infinity];
  const high: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const index of indices)
    for (let axis = 0; axis < 3; axis++) {
      low[axis] = Math.min(low[axis] ?? Infinity, elements[index]?.low[axis] ?? Infinity);
      high[axis] = Math.max(high[axis] ?? -Infinity, elements[index]?.high[axis] ?? -Infinity);
    }
  const axis = [0, 1, 2].reduce((best, a) => ((high[a] ?? 0) - (low[a] ?? 0) > (high[best] ?? 0) - (low[best] ?? 0) ? a : best), 0);
  const centre = (index: number): number => ((elements[index]?.low[axis] ?? 0) + (elements[index]?.high[axis] ?? 0)) / 2;
  const sorted = [...indices].sort((a, b) => centre(a) - centre(b) || a - b);
  const half = sorted.length >> 1;
  return { low, high, left: build(elements, sorted.slice(0, half)), right: build(elements, sorted.slice(half)) };
}

interface Hit {
  readonly element: number;
  readonly distance: number;
  readonly point: Vec;
}

/** The lowest-index element containing p (distance 0), else the nearest element (ties: lowest index). Branch and bound on box distance. */
function locate(tree: Tree, elements: readonly SourceElement[], p: Vec): Hit | null {
  let best: Hit | null = null;
  const visit = (node: Tree): void => {
    if (best !== null && boxDistance(node.low, node.high, p) > best.distance + TIE) return;
    if (node.element !== undefined) {
      const element = elements[node.element];
      if (element === undefined) return;
      const closest = closestOnTet(element.corners, p);
      if (
        best === null ||
        closest.distance < best.distance - TIE ||
        (Math.abs(closest.distance - best.distance) <= TIE && node.element < best.element)
      )
        best = { element: node.element, distance: closest.distance, point: closest.point };
      return;
    }
    const children = [node.left, node.right].filter((child): child is Tree => child !== undefined);
    children.sort((a, b) => boxDistance(a.low, a.high, p) - boxDistance(b.low, b.high, p));
    for (const child of children) visit(child);
  };
  visit(tree);
  return best;
}

function sourceElements(mesh: FeMeshArtifact): SourceElement[] | null {
  const coordinates = new Map(mesh.nodes.map(([id, x, y, z]) => [id, [x, y, z] as Vec]));
  const out: SourceElement[] = [];
  for (const block of mesh.blocks) {
    for (const element of block.elements) {
      const nodes = element.slice(1);
      if (nodes.length !== 4 && nodes.length !== 10) return null;
      const points = nodes.map((id) => coordinates.get(id));
      if (points.some((point) => point === undefined)) return null;
      const corners = points.slice(0, 4) as unknown as [Vec, Vec, Vec, Vec];
      const all = points as Vec[];
      out.push({
        nodes,
        corners,
        low: [0, 1, 2].map((axis) => Math.min(...all.map((p) => p[axis] ?? 0))) as unknown as Vec,
        high: [0, 1, 2].map((axis) => Math.max(...all.map((p) => p[axis] ?? 0))) as unknown as Vec,
      });
    }
  }
  return out;
}

/**
 * `sourceValues` (by source node id) interpolated at every node of `target`, aligned with `target.nodes`.
 * @invariant deterministic (lowest element index among containing elements); a target node at a source node reproduces its value
 * @failure a source element that is not C3D4 / C3D10, a missing node or no element -> refusal; a source value missing for a node -> refusal
 */
export function mapNodalField(
  source: FeMeshArtifact,
  sourceValues: ReadonlyMap<number, number>,
  target: FeMeshArtifact,
): MappedField | MappingRefusal {
  const elements = sourceElements(source);
  if (elements === null || elements.length === 0)
    return { ok: false, message: 'the source mesh has no C3D4 / C3D10 elements with all their nodes' };
  const tree = build(
    elements,
    elements.map((_, i) => i),
  );
  const values: number[] = [];
  const used: number[] = [];
  const distances: number[] = [];
  for (const [, x, y, z] of target.nodes) {
    const p: Vec = [x, y, z];
    const hit = locate(tree, elements, p);
    const element = hit === null ? undefined : elements[hit.element];
    if (hit === null || element === undefined) return { ok: false, message: 'no source element found for a target node' };
    const l = barycentric(element.corners, hit.point);
    if (l === null) return { ok: false, message: `source element ${hit.element + 1} is degenerate` };
    const weights = shape(l, element.nodes.length);
    let value = 0;
    for (const [i, node] of element.nodes.entries()) {
      const nodal = sourceValues.get(node);
      if (nodal === undefined || !Number.isFinite(nodal)) return { ok: false, message: `the source has no finite value at node ${node}` };
      value += (weights[i] ?? 0) * nodal;
    }
    values.push(value);
    used.push(hit.element);
    distances.push(hit.distance);
  }
  return { ok: true, values, elements: used, distances, report: mappingReport(source, sourceValues, target, values, distances) };
}

/**
 * The TR-TMC-23 report of mapped `values` / `distances` (aligned with `target.nodes`): nodes moved by more than 1e-9 x the source size, the
 * largest such move, and the largest error at target nodes that coincide with a source node. Shared by the TS mapping and the native
 * mapped-field reader, so both report alike. Loops, not spreads: meshes of 200k nodes overflow `Math.min(...array)`.
 */
export function mappingReport(
  source: FeMeshArtifact,
  sourceValues: ReadonlyMap<number, number>,
  target: FeMeshArtifact,
  values: readonly number[],
  distances: readonly number[],
): MappingReport {
  const low = [Infinity, Infinity, Infinity];
  const high = [-Infinity, -Infinity, -Infinity];
  for (const node of source.nodes)
    for (let axis = 0; axis < 3; axis += 1) {
      const value = node[axis + 1] ?? 0;
      if (value < (low[axis] ?? 0)) low[axis] = value;
      if (value > (high[axis] ?? 0)) high[axis] = value;
    }
  const size = Math.hypot(...high.map((h, axis) => h - (low[axis] ?? 0)));
  const tolerance = 1e-9 * size;
  const exact = new Map<string, number>(source.nodes.map(([id, x, y, z]) => [`${x}|${y}|${z}`, id]));
  let maxDistance = 0;
  let outside = 0;
  let coincident = 0;
  let coincidentError = 0;
  for (const [index, [, x, y, z]] of target.nodes.entries()) {
    const distance = distances[index] ?? Number.NaN;
    if (distance > tolerance) {
      outside += 1;
      maxDistance = Math.max(maxDistance, distance);
    }
    const same = exact.get(`${x}|${y}|${z}`);
    if (same !== undefined) {
      coincident += 1;
      coincidentError = Math.max(coincidentError, Math.abs((values[index] ?? Number.NaN) - (sourceValues.get(same) ?? Number.NaN)));
    }
  }
  return { maxMappingDistance: maxDistance, outside, coincidentMaxError: coincidentError, coincidentNodes: coincident };
}
