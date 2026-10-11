/**
 * Incremental Delaunay triangulation (Bowyer–Watson with point-location walking and a directed-edge
 * map), used to build terrain TINs from survey points.
 * @layer domain-aec/civil
 * @pure
 */

import type { Vec2 } from '@core/model/types';

/** Counter-clockwise triangles as flat vertex-index triples into the input array. */
export type Triangles = number[];

function orient(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number {
  return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
}

/** True when (px, py) lies strictly inside the circumcircle of CCW triangle a, b, c. */
function inCircle(points: ReadonlyArray<Vec2>, a: number, b: number, c: number, p: Vec2): boolean {
  const [px, py] = p;
  const pa = points[a] as Vec2;
  const pb = points[b] as Vec2;
  const pc = points[c] as Vec2;
  const adx = pa[0] - px;
  const ady = pa[1] - py;
  const bdx = pb[0] - px;
  const bdy = pb[1] - py;
  const cdx = pc[0] - px;
  const cdy = pc[1] - py;
  const ad = adx * adx + ady * ady;
  const bd = bdx * bdx + bdy * bdy;
  const cd = cdx * cdx + cdy * cdy;
  const det =
    adx * (bdy * cd - bd * cdy) - ady * (bdx * cd - bd * cdx) + ad * (bdx * cdy - bdy * cdx);
  return det > 0;
}

/** Spatially coherent insertion order (serpentine rows) so the location walk stays short. */
function insertionOrder(points: ReadonlyArray<Vec2>, count: number): number[] {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < count; i++) {
    const [x, y] = points[i] as Vec2;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  const rows = Math.max(1, Math.round(Math.sqrt(count / 4)));
  const rowHeight = (maxY - minY) / rows || 1;
  const key = (index: number): [number, number] => {
    const [x, y] = points[index] as Vec2;
    const row = Math.min(rows - 1, Math.floor((y - minY) / rowHeight));
    return [row, row % 2 === 0 ? x - minX : maxX - x];
  };
  const indices = Array.from({ length: count }, (_, index) => index);
  const keys = indices.map(key);
  return indices.sort((a, b) => {
    const [rowA, xA] = keys[a] as [number, number];
    const [rowB, xB] = keys[b] as [number, number];
    return rowA - rowB || xA - xB;
  });
}

/**
 * Delaunay triangulation of distinct plan points.
 * @invariant every returned triangle is counter-clockwise and references input indices only
 * @failure fewer than 3 non-collinear points -> []
 */
export function delaunay(input: ReadonlyArray<Vec2>): Triangles {
  const count = input.length;
  if (count < 3) return [];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of input) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  const span = Math.max(maxX - minX, maxY - minY) || 1;
  const midX = (minX + maxX) / 2;
  const midY = (minY + maxY) / 2;
  const points: Vec2[] = [
    ...input,
    [midX - 40 * span, midY - 30 * span],
    [midX + 40 * span, midY - 30 * span],
    [midX, midY + 40 * span],
  ];
  const stride = count + 3;
  const vertices: number[] = [];
  const alive: boolean[] = [];
  const edges = new Map<number, number>();
  const addTriangle = (a: number, b: number, c: number): number => {
    const index = alive.length;
    vertices.push(a, b, c);
    alive.push(true);
    edges.set(a * stride + b, index);
    edges.set(b * stride + c, index);
    edges.set(c * stride + a, index);
    return index;
  };
  const corner = (triangle: number, k: number): number => vertices[triangle * 3 + k] as number;
  let last = addTriangle(count, count + 1, count + 2);

  const locate = (p: Vec2): number => {
    let current = last;
    for (let steps = 0; steps < 4 * stride; steps++) {
      let moved = false;
      for (let k = 0; k < 3; k++) {
        const a = corner(current, k);
        const b = corner(current, (k + 1) % 3);
        const pa = points[a] as Vec2;
        const pb = points[b] as Vec2;
        if (orient(pa[0], pa[1], pb[0], pb[1], p[0], p[1]) < 0) {
          const neighbour = edges.get(b * stride + a);
          if (neighbour !== undefined) {
            current = neighbour;
            moved = true;
            break;
          }
        }
      }
      if (!moved) return current;
    }
    return alive.findIndex((isAlive, triangle) => {
      if (!isAlive) return false;
      return [0, 1, 2].every((k) => {
        const pa = points[corner(triangle, k)] as Vec2;
        const pb = points[corner(triangle, (k + 1) % 3)] as Vec2;
        return orient(pa[0], pa[1], pb[0], pb[1], p[0], p[1]) >= 0;
      });
    });
  };

  for (const index of insertionOrder(points, count)) {
    const p = points[index] as Vec2;
    const seed = locate(p);
    if (seed < 0) continue;
    const bad = new Set<number>([seed]);
    const queue = [seed];
    while (queue.length > 0) {
      const triangle = queue.pop() as number;
      for (let k = 0; k < 3; k++) {
        const a = corner(triangle, k);
        const b = corner(triangle, (k + 1) % 3);
        const neighbour = edges.get(b * stride + a);
        if (neighbour === undefined || bad.has(neighbour)) continue;
        if (inCircle(points, corner(neighbour, 0), corner(neighbour, 1), corner(neighbour, 2), p)) {
          bad.add(neighbour);
          queue.push(neighbour);
        }
      }
    }
    const boundary: Array<[number, number]> = [];
    for (const triangle of bad) {
      for (let k = 0; k < 3; k++) {
        const a = corner(triangle, k);
        const b = corner(triangle, (k + 1) % 3);
        const neighbour = edges.get(b * stride + a);
        if (neighbour === undefined || !bad.has(neighbour)) boundary.push([a, b]);
      }
    }
    for (const triangle of bad) {
      alive[triangle] = false;
      for (let k = 0; k < 3; k++) {
        const key = corner(triangle, k) * stride + corner(triangle, (k + 1) % 3);
        if (edges.get(key) === triangle) edges.delete(key);
      }
    }
    for (const [a, b] of boundary) {
      const pa = points[a] as Vec2;
      const pb = points[b] as Vec2;
      if (orient(pa[0], pa[1], pb[0], pb[1], p[0], p[1]) <= 0) continue;
      last = addTriangle(a, b, index);
    }
  }

  const result: Triangles = [];
  for (let triangle = 0; triangle < alive.length; triangle++) {
    if (!alive[triangle]) continue;
    const a = corner(triangle, 0);
    const b = corner(triangle, 1);
    const c = corner(triangle, 2);
    if (a >= count || b >= count || c >= count) continue;
    result.push(a, b, c);
  }
  return result;
}
