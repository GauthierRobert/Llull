/**
 * Nodal load distribution of a target (05 §5.6): area-consistent weights of a total force over the faces it acts on, and the statically equivalent
 * nodal force couple of a moment. Pure functions of the mesh artifact; the deck writer turns the result into `*CLOAD` lines.
 */

import type { FeMeshArtifact } from '@core/model/analysis';
import type { Vec3 } from '@core/model/vectors';
import { jacobiRotate } from '@lib/symmetricEigen';
import { cross3, len3, sub3 } from '@lib/vec3';
import type { DeckContext } from './context';

/** Corner positions (0-based) of the four tetrahedron faces in CalculiX numbering (S1 = 1-2-3, S2 = 1-4-2, S3 = 2-4-3, S4 = 3-4-1). */
const TET_FACES: readonly (readonly [number, number, number])[] = [
  [0, 1, 2],
  [0, 3, 1],
  [1, 3, 2],
  [2, 3, 0],
];
/** Mid-edge node position (0-based, within the element's node list) of the corner pair (i, j) of a C3D10: 5 = 1-2, 6 = 2-3, 7 = 3-1, 8 = 1-4, 9 = 2-4, 10 = 3-4. */
const MID_NODE: Readonly<Record<string, number>> = { '01': 4, '12': 5, '02': 6, '03': 7, '13': 8, '23': 9 };
const midOf = (i: number, j: number): number => MID_NODE[i < j ? `${i}${j}` : `${j}${i}`] ?? -1;

/** Eigenvalues below this fraction of the largest are treated as zero when inverting the inertia-like matrix of a moment patch. */
const RANK_TOLERANCE = 1e-9;
/** A couple is accepted when the forces reproduce the requested moment to this relative residual. */
const MOMENT_RESIDUAL = 1e-6;

/** Element nodes by id (first block wins). */
function elementIndex(mesh: FeMeshArtifact): Map<number, { readonly type: string; readonly nodes: readonly number[] }> {
  const index = new Map<number, { type: string; nodes: readonly number[] }>();
  for (const block of mesh.blocks)
    for (const element of block.elements) index.set(element[0] ?? -1, { type: block.type, nodes: element.slice(1) });
  return index;
}

/**
 * Consistent nodal shares of a uniform traction over the faces of `targetKey` (they sum to 1): a linear triangle gives each corner A / 3, a quadratic one
 * gives its three mid-edge nodes A / 3 each and the corners nothing (the exact result of integrating the shape functions). The face area is the area of
 * the corner triangle. Null when the target has no faces, a face cannot be resolved, or the target also holds nodes that are not on its faces (a target
 * mixing facesNear with pointsNear / edgesNear): the caller then splits equally over ALL target nodes.
 */
export function consistentWeights(ctx: DeckContext, targetKey: string): ReadonlyMap<number, number> | null {
  const faces = ctx.faces(targetKey);
  if (faces.length === 0) return null;
  const position = new Map<number, Vec3>(ctx.mesh.nodes.map((node) => [node[0], [node[1], node[2], node[3]]]));
  const elements = elementIndex(ctx.mesh);
  const shares = new Map<number, number>();
  const faceNodes = new Set<number>();
  let total = 0;
  for (const [elementId, label] of faces) {
    const element = elements.get(elementId);
    const corners = TET_FACES[label - 1];
    if (element === undefined || corners === undefined || (element.type !== 'C3D4' && element.type !== 'C3D10')) return null;
    const points = corners.map((corner) => position.get(element.nodes[corner] ?? -1));
    if (points.some((point) => point === undefined)) return null;
    const [a, b, c] = points as [Vec3, Vec3, Vec3];
    const area = len3(cross3(sub3(b, a), sub3(c, a))) / 2;
    const carriers =
      element.type === 'C3D10'
        ? [midOf(corners[0], corners[1]), midOf(corners[1], corners[2]), midOf(corners[2], corners[0])]
        : [corners[0], corners[1], corners[2]];
    for (const slot of [...corners, ...(element.type === 'C3D10' ? carriers : [])]) faceNodes.add(element.nodes[slot] ?? -1);
    for (const slot of carriers) {
      const node = element.nodes[slot];
      if (node === undefined) return null;
      shares.set(node, (shares.get(node) ?? 0) + area / 3);
    }
    total += area;
  }
  if (!(total > 0)) return null;
  const targetNodes = Object.hasOwn(ctx.mesh.nodeSets, targetKey) ? (ctx.mesh.nodeSets[targetKey] ?? []) : [];
  if (targetNodes.some((node) => !faceNodes.has(node))) return null;
  return new Map([...shares].map(([node, share]) => [node, share / total]));
}

type Matrix3 = number[][];

const at = (matrix: Matrix3, i: number, j: number): number => matrix[i]?.[j] ?? 0;
const put = (matrix: Matrix3, i: number, j: number, value: number): void => void ((matrix[i] as number[])[j] = value);
const dot = (a: readonly number[], b: readonly number[]): number =>
  (a[0] ?? 0) * (b[0] ?? 0) + (a[1] ?? 0) * (b[1] ?? 0) + (a[2] ?? 0) * (b[2] ?? 0);

/** Eigen decomposition of a symmetric 3 x 3 matrix by cyclic Jacobi sweeps: eigenvalues and the matching unit eigenvectors. */
function eigenSymmetric(matrix: Matrix3): { values: number[]; vectors: number[][] } {
  const a = matrix.map((row) => [...row]);
  const v = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  for (let sweep = 0; sweep < 32; sweep++) {
    if (Math.abs(at(a, 0, 1)) + Math.abs(at(a, 0, 2)) + Math.abs(at(a, 1, 2)) < 1e-300) break;
    for (const [p, q] of [
      [0, 1],
      [0, 2],
      [1, 2],
    ] as const) {
      jacobiRotate(a, v, p, q);
    }
  }
  return { values: [at(a, 0, 0), at(a, 1, 1), at(a, 2, 2)], vectors: [0, 1, 2].map((j) => [at(v, 0, j), at(v, 1, j), at(v, 2, j)]) };
}

export type MomentForces = { readonly forces: ReadonlyMap<number, Vec3> } | { readonly refusal: string };

/**
 * Nodal forces that carry the pure moment `moment` (force x length of the case unit system) on `nodes`: `F_i = omega x d_i` with `d_i` the position of
 * node i relative to the centroid of the nodes and `omega = A^-1 M`, `A = sum(|d|^2 I - d d^T)`. Their resultant force is zero and their moment about any
 * point is exactly M, so the load is statically equivalent to the couple (it distributes like a rigid coupling would, without constraining the face).
 * @failure nodes that cannot carry the moment (fewer than 2 nodes, or collinear nodes for a moment about their line) -> `{ refusal }`
 */
export function momentForces(mesh: FeMeshArtifact, nodes: readonly number[], moment: Vec3): MomentForces {
  const position = new Map<number, Vec3>(mesh.nodes.map((node) => [node[0], [node[1], node[2], node[3]]]));
  const points = nodes.flatMap((id) => {
    const point = position.get(id);
    return point === undefined ? [] : [{ id, point }];
  });
  if (points.length < 2) return { refusal: `a moment needs at least 2 nodes on its target, found ${points.length}` };
  const mean = (axis: 0 | 1 | 2): number => points.reduce((sum, entry) => sum + entry.point[axis], 0) / points.length;
  const centre: Vec3 = [mean(0), mean(1), mean(2)];
  const offsets = points.map((entry) => sub3(entry.point, centre));
  const inertia: Matrix3 = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  for (const d of offsets) {
    const square = dot(d, d);
    for (let i = 0; i < 3; i++)
      for (let j = 0; j < 3; j++) put(inertia, i, j, at(inertia, i, j) + (i === j ? square : 0) - (d[i] ?? 0) * (d[j] ?? 0));
  }
  const { values, vectors } = eigenSymmetric(inertia);
  const largest = Math.max(...values);
  const omega = [0, 0, 0];
  values.forEach((value, index) => {
    if (!(value > RANK_TOLERANCE * largest)) return;
    const direction = vectors[index] ?? [0, 0, 0];
    const gain = dot(direction, moment) / value;
    for (let axis = 0; axis < 3; axis++) omega[axis] = (omega[axis] ?? 0) + gain * (direction[axis] ?? 0);
  });
  const rotation: Vec3 = [omega[0] ?? 0, omega[1] ?? 0, omega[2] ?? 0];
  const forces = new Map<number, Vec3>();
  const achieved = [0, 0, 0];
  points.forEach((entry, index) => {
    const d = offsets[index] ?? centre;
    const force = cross3(rotation, d);
    forces.set(entry.id, force);
    const arm = cross3(d, force);
    for (let axis = 0; axis < 3; axis++) achieved[axis] = (achieved[axis] ?? 0) + (arm[axis] ?? 0);
  });
  const residual = len3(sub3([achieved[0] ?? 0, achieved[1] ?? 0, achieved[2] ?? 0], moment));
  if (residual > MOMENT_RESIDUAL * len3(moment))
    return {
      refusal:
        'the target nodes are collinear (or too few) to carry a moment about their line: put the moment on a face or on non-collinear nodes',
    };
  return { forces };
}
