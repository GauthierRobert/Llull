/** Geometry of a tet mesh artifact for the thermal summariser: element index, volumes, face integrals (C3D4 / C3D10, CalculiX face labels). */

import type { FeMeshArtifact } from '@core/model/analysis';
import type { Vec3 } from '@core/model/vectors';
import { cross3, dot3, sub3 } from '@lib/vec3';

export interface MeshElement {
  readonly id: number;
  readonly type: 'C3D4' | 'C3D10';
  readonly entityId: string;
  readonly nodes: readonly number[];
}

export interface MeshIndex {
  readonly coordinates: ReadonlyMap<number, Vec3>;
  readonly elements: ReadonlyMap<number, MeshElement>;
  /** First element (lowest id) that contains each node: gives the part of a node. */
  readonly entityOfNode: ReadonlyMap<number, string>;
}

/** Index of the nodes and tet elements of `mesh` (other element types are ignored). */
export function indexMesh(mesh: FeMeshArtifact): MeshIndex {
  const coordinates = new Map<number, Vec3>(mesh.nodes.map(([id, x, y, z]) => [id, [x, y, z]]));
  const elements = new Map<number, MeshElement>();
  const entityOfNode = new Map<number, string>();
  for (const block of mesh.blocks) {
    if (block.type !== 'C3D4' && block.type !== 'C3D10') continue;
    for (const [id = 0, ...nodes] of block.elements) {
      elements.set(id, { id, type: block.type, entityId: block.entityId, nodes });
      for (const node of nodes) if (!entityOfNode.has(node)) entityOfNode.set(node, block.entityId);
    }
  }
  return { coordinates, elements, entityOfNode };
}

const origin: Vec3 = [0, 0, 0];

const at = (index: MeshIndex, node: number | undefined): Vec3 => (node === undefined ? origin : (index.coordinates.get(node) ?? origin));

/** Volume of a tet element from its corner nodes (straight-sided; mid-side nodes of a C3D10 do not enter). */
export function elementVolume(index: MeshIndex, element: MeshElement): number {
  const [a, b, c, d] = element.nodes.slice(0, 4).map((node) => at(index, node));
  if (a === undefined || b === undefined || c === undefined || d === undefined) return 0;
  return Math.abs(dot3(cross3(sub3(b, a), sub3(c, a)), sub3(d, a))) / 6;
}

/** Sum of the element volumes of each part (analysis length unit cubed). */
export function partVolumes(index: MeshIndex): Map<string, number> {
  const volumes = new Map<string, number>();
  for (const element of index.elements.values())
    volumes.set(element.entityId, (volumes.get(element.entityId) ?? 0) + elementVolume(index, element));
  return volumes;
}

/** Weights w_i with sum w_i f(node_i) = integral of a function interpolated by the element's shape functions (exact for quadratics on a C3D10). */
export function nodalWeights(element: MeshElement, volume: number): readonly number[] {
  return element.type === 'C3D4'
    ? [volume / 4, volume / 4, volume / 4, volume / 4]
    : [-1, -1, -1, -1, 4, 4, 4, 4, 4, 4].map((w) => (w * volume) / 20);
}

/** Local node numbers (1-based) of each CalculiX tet face: corners a, b, c, then mid-side nodes ab, bc, ca for a C3D10. */
const FACES: Readonly<Record<number, readonly [number, number, number, number, number, number]>> = {
  1: [1, 2, 3, 5, 6, 7],
  2: [1, 4, 2, 8, 9, 5],
  3: [2, 4, 3, 9, 10, 6],
  4: [3, 4, 1, 10, 8, 7],
};

/** Node ids of face `label` of `element` (3 corners, plus 3 mid-side nodes for a C3D10), or null for an invalid label. */
export function faceNodes(element: MeshElement, label: number): readonly number[] | null {
  const local = Object.hasOwn(FACES, label) ? FACES[label] : undefined;
  if (local === undefined) return null;
  const count = element.type === 'C3D4' ? 3 : 6;
  const nodes = local.slice(0, count).map((n) => element.nodes[n - 1]);
  return nodes.every((n): n is number => n !== undefined) ? nodes : null;
}

const S15 = Math.sqrt(15);
const A1 = (6 - S15) / 21;
const B1 = (9 + 2 * S15) / 21;
const A2 = (6 + S15) / 21;
const B2 = (9 - 2 * S15) / 21;
const W1 = (155 - S15) / 1200;
const W2 = (155 + S15) / 1200;
/** Radon 7-point rule (degree 5) on a triangle: barycentric coordinates and weights (sum 1). */
const RULE: readonly (readonly [number, number, number, number])[] = [
  [1 / 3, 1 / 3, 1 / 3, 9 / 40],
  [A1, A1, B1, W1],
  [A1, B1, A1, W1],
  [B1, A1, A1, W1],
  [A2, A2, B2, W2],
  [A2, B2, A2, W2],
  [B2, A2, A2, W2],
];

/** Interpolated value at barycentric (l1, l2, l3) of a 3-node (linear) or 6-node (quadratic) triangle with nodal values `v`. */
function interpolate(v: readonly number[], l1: number, l2: number, l3: number): number {
  if (v.length === 3) return l1 * (v[0] ?? 0) + l2 * (v[1] ?? 0) + l3 * (v[2] ?? 0);
  return (
    (v[0] ?? 0) * l1 * (2 * l1 - 1) +
    (v[1] ?? 0) * l2 * (2 * l2 - 1) +
    (v[2] ?? 0) * l3 * (2 * l3 - 1) +
    4 * ((v[3] ?? 0) * l1 * l2 + (v[4] ?? 0) * l2 * l3 + (v[5] ?? 0) * l3 * l1)
  );
}

export interface FaceIntegral {
  /** Face area (analysis length unit squared), from the corner nodes. */
  readonly area: number;
  /** Integral over the face of `g(T)` (analysis length unit squared times the unit of g). */
  readonly integral: number;
}

/**
 * Area of a face and the integral of `g(T)` over it, with T interpolated from the nodal field by the face shape functions (degree-5 rule).
 * @failure a node without a value -> T 0 at that node (callers check coverage with `hasField`)
 */
export function integrateFace(
  index: MeshIndex,
  nodes: readonly number[],
  field: (node: number) => number,
  g: (temperature: number) => number,
): FaceIntegral {
  const [a, b, c] = nodes.slice(0, 3).map((node) => at(index, node));
  const area = a === undefined || b === undefined || c === undefined ? 0 : Math.hypot(...cross3(sub3(b, a), sub3(c, a))) / 2;
  const values = nodes.map(field);
  const mean = RULE.reduce((sum, [l1, l2, l3, w]) => sum + w * g(interpolate(values, l1, l2, l3)), 0);
  return { area, integral: area * mean };
}
