/** Point evaluation of a nodal field inside the tetrahedron that contains the point (linear C3D4 / quadratic C3D10 shape functions). */

import type { FeMeshArtifact } from '@core/model/analysis';
import type { Vec3 } from '@core/model/vectors';

/** Barycentric coordinates below this (relative to the element) still count as inside: mesher coordinates are single precision. */
const INSIDE_TOLERANCE = 1e-5;

export interface PointWeights {
  /** Node ids with the shape-function value of the point at each. */
  readonly nodes: readonly (readonly [node: number, weight: number])[];
}

const det3 = (a: Vec3, b: Vec3, c: Vec3): number =>
  a[0] * (b[1] * c[2] - b[2] * c[1]) - b[0] * (a[1] * c[2] - a[2] * c[1]) + c[0] * (a[1] * b[2] - a[2] * b[1]);

/** Barycentric coordinates of `point` in the tetrahedron `corners` (Cramer's rule on the edge vectors from corner 1). */
function barycentric(corners: readonly Vec3[], point: Vec3): readonly [number, number, number, number] | null {
  const [a, b, c, d] = corners;
  if (a === undefined || b === undefined || c === undefined || d === undefined) return null;
  const from = (p: Vec3): Vec3 => [p[0] - a[0], p[1] - a[1], p[2] - a[2]];
  const [u, v, w, r] = [from(b), from(c), from(d), from(point)];
  const det = det3(u, v, w);
  if (det === 0) return null;
  const [l2, l3, l4] = [det3(r, v, w) / det, det3(u, r, w) / det, det3(u, v, r) / det];
  return [1 - l2 - l3 - l4, l2, l3, l4];
}

/** CalculiX C3D10 mid-edge nodes 5..10 lie on the edges 1-2, 2-3, 3-1, 1-4, 2-4, 3-4. */
const MID_EDGES = [
  [0, 1],
  [1, 2],
  [2, 0],
  [0, 3],
  [1, 3],
  [2, 3],
] as const;

function weightsOf(nodes: readonly number[], lambda: readonly number[], quadratic: boolean): PointWeights['nodes'] {
  const corners = lambda.map((value, i): [number, number] => [nodes[i] ?? 0, quadratic ? value * (2 * value - 1) : value]);
  if (!quadratic) return corners;
  const mids = MID_EDGES.map(([i, j], k): [number, number] => [nodes[4 + k] ?? 0, 4 * (lambda[i] ?? 0) * (lambda[j] ?? 0)]);
  return [...corners, ...mids];
}

/** Shape-function weights of `point` (analysis units) in the best-containing C3D4 / C3D10 element of the mesh, or null when none contains it. */
export function locatePoint(mesh: FeMeshArtifact, point: Vec3): PointWeights | null {
  const coordinates = new Map(mesh.nodes.map((node): [number, Vec3] => [node[0], [node[1], node[2], node[3]]]));
  let best: { score: number; weights: PointWeights['nodes'] } | null = null;
  for (const block of mesh.blocks) {
    if (block.type !== 'C3D4' && block.type !== 'C3D10') continue;
    const quadratic = block.type === 'C3D10';
    for (const element of block.elements) {
      const ids = element.slice(1);
      const corners = ids.slice(0, 4).map((id) => coordinates.get(id));
      if (corners.some((corner) => corner === undefined)) continue;
      const known = corners as Vec3[];
      const lambda = barycentric(known, point);
      if (lambda === null) continue;
      const score = Math.min(...lambda);
      if (best === null || score > best.score) best = { score, weights: weightsOf(ids, lambda, quadratic) };
    }
  }
  return best !== null && best.score >= -INSIDE_TOLERANCE ? { nodes: best.weights } : null;
}
