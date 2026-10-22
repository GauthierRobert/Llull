/** Triangle subdivision: midpoint (linear, geometry unchanged) and Loop (approximating, boundary-aware). Each level quadruples the face count. */

import type { Vec3 } from '../../model/vectors';

export interface SubdividedMesh {
  readonly positions: number[];
  readonly triangles: number[];
}

type EdgeKey = number;

interface Level {
  positions: number[];
  triangles: number[];
}

function midpointLevel(mesh: Level): Level {
  const vertexCount = mesh.positions.length / 3;
  const positions = [...mesh.positions];
  const midpoints = new Map<EdgeKey, number>();
  const midpoint = (a: number, b: number): number => {
    const key = Math.min(a, b) * vertexCount + Math.max(a, b);
    let index = midpoints.get(key);
    if (index === undefined) {
      index = positions.length / 3;
      midpoints.set(key, index);
      for (let axis = 0; axis < 3; axis++)
        positions.push(((mesh.positions[a * 3 + axis] as number) + (mesh.positions[b * 3 + axis] as number)) / 2);
    }
    return index;
  };
  const triangles: number[] = [];
  for (let f = 0; f + 2 < mesh.triangles.length; f += 3) {
    const [a, b, c] = [mesh.triangles[f] as number, mesh.triangles[f + 1] as number, mesh.triangles[f + 2] as number];
    const [ab, bc, ca] = [midpoint(a, b), midpoint(b, c), midpoint(c, a)];
    triangles.push(a, ab, ca, ab, b, bc, ca, bc, c, ab, bc, ca);
  }
  return { positions, triangles };
}

/** Loop (1987) weights: interior edge 3/8 + 3/8 + 1/8 + 1/8, boundary edge 1/2 + 1/2; interior vertex beta(n), boundary vertex 3/4 + 1/8 + 1/8. */
function loopLevel(mesh: Level): Level {
  const vertexCount = mesh.positions.length / 3;
  const at = (i: number): Vec3 => [
    mesh.positions[i * 3] as number,
    mesh.positions[i * 3 + 1] as number,
    mesh.positions[i * 3 + 2] as number,
  ];
  const edgeFaces = new Map<EdgeKey, { a: number; b: number; opposite: number[] }>();
  const neighbours: Array<Set<number>> = Array.from({ length: vertexCount }, () => new Set<number>());
  for (let f = 0; f + 2 < mesh.triangles.length; f += 3) {
    const corners = [mesh.triangles[f] as number, mesh.triangles[f + 1] as number, mesh.triangles[f + 2] as number];
    corners.forEach((a, k) => {
      const b = corners[(k + 1) % 3] as number;
      const opposite = corners[(k + 2) % 3] as number;
      const key = Math.min(a, b) * vertexCount + Math.max(a, b);
      const entry = edgeFaces.get(key);
      if (entry === undefined) edgeFaces.set(key, { a: Math.min(a, b), b: Math.max(a, b), opposite: [opposite] });
      else entry.opposite.push(opposite);
      neighbours[a]?.add(b);
      neighbours[b]?.add(a);
    });
  }
  const boundaryNeighbours: number[][] = Array.from({ length: vertexCount }, () => []);
  const positions: number[] = [];
  const edgeVertex = new Map<EdgeKey, number>();
  for (const edge of edgeFaces.values()) {
    if (edge.opposite.length === 1) {
      boundaryNeighbours[edge.a]?.push(edge.b);
      boundaryNeighbours[edge.b]?.push(edge.a);
    }
  }
  for (let v = 0; v < vertexCount; v++) {
    const p = at(v);
    const ring = [...(neighbours[v] ?? [])];
    const border = boundaryNeighbours[v] ?? [];
    let next: Vec3;
    if (border.length === 2) {
      const [q, r] = [at(border[0] as number), at(border[1] as number)];
      next = [0, 1, 2].map((k) => 0.75 * (p[k] as number) + 0.125 * ((q[k] as number) + (r[k] as number))) as unknown as Vec3;
    } else {
      const n = ring.length;
      const beta = n === 3 ? 3 / 16 : 3 / (8 * n);
      const sum = ring.reduce<Vec3>((s, i) => [s[0] + at(i)[0], s[1] + at(i)[1], s[2] + at(i)[2]], [0, 0, 0]);
      next = [0, 1, 2].map((k) => (1 - n * beta) * (p[k] as number) + beta * (sum[k] as number)) as unknown as Vec3;
    }
    positions.push(...next);
  }
  for (const [key, edge] of edgeFaces) {
    const [pa, pb] = [at(edge.a), at(edge.b)];
    const odd = edge.opposite.length === 2 ? edge.opposite.map(at) : null;
    edgeVertex.set(key, positions.length / 3);
    for (let k = 0; k < 3; k++) {
      positions.push(
        odd === null
          ? ((pa[k] as number) + (pb[k] as number)) / 2
          : (3 / 8) * ((pa[k] as number) + (pb[k] as number)) + (1 / 8) * ((odd[0]?.[k] ?? 0) + (odd[1]?.[k] ?? 0)),
      );
    }
  }
  const triangles: number[] = [];
  const mid = (a: number, b: number): number => edgeVertex.get(Math.min(a, b) * vertexCount + Math.max(a, b)) as number;
  for (let f = 0; f + 2 < mesh.triangles.length; f += 3) {
    const [a, b, c] = [mesh.triangles[f] as number, mesh.triangles[f + 1] as number, mesh.triangles[f + 2] as number];
    const [ab, bc, ca] = [mid(a, b), mid(b, c), mid(c, a)];
    triangles.push(a, ab, ca, ab, b, bc, ca, bc, c, ab, bc, ca);
  }
  return { positions, triangles };
}

/**
 * Subdivide `levels` times.
 * @invariant faces x 4^levels; `midpoint` keeps area and volume exactly; `loop` smooths (shrinks convex shapes)
 */
export function subdivideMesh(mesh: Level, method: 'midpoint' | 'loop', levels: number): SubdividedMesh {
  let current: Level = mesh;
  for (let i = 0; i < levels; i++) current = method === 'midpoint' ? midpointLevel(current) : loopLevel(current);
  return current;
}
