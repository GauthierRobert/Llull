/** Self-intersection count of an indexed triangle mesh: uniform-grid broad phase over triangles sharing no vertex, then edge-through-interior tests. */

import { segmentHitsTriangle } from '../../lib/segmentTriangle';
import type { Vec3 } from '../../model/vectors';

export interface SelfIntersections {
  readonly count: number;
  /** The first pairs found, as `[faceA, faceB]` with faceA < faceB. */
  readonly pairs: Array<readonly [number, number]>;
}

/** Grid cells one triangle may occupy before it is treated as a large triangle. */
const MAX_CELLS_PER_FACE = 64;

type Corners = readonly [Vec3, Vec3, Vec3];

/** Transversal crossings only: coplanar overlaps and pure contacts (shared edges, touching corners) are not counted. */
function trianglesCross(a: Corners, b: Corners): boolean {
  for (let k = 0; k < 3; k++) {
    if (segmentHitsTriangle(a[k] as Vec3, a[(k + 1) % 3] as Vec3, b)) return true;
    if (segmentHitsTriangle(b[k] as Vec3, b[(k + 1) % 3] as Vec3, a)) return true;
  }
  return false;
}

/**
 * Count the face pairs that cross each other.
 * @invariant pairs that share a vertex are skipped; the result is deterministic (ascending face order)
 */
export function findSelfIntersections(
  positions: ReadonlyArray<number>,
  triangles: ReadonlyArray<number>,
  maxListed: number,
): SelfIntersections {
  const faceCount = Math.floor(triangles.length / 3);
  const corner = (index: number): Vec3 => [
    positions[index * 3] as number,
    positions[index * 3 + 1] as number,
    positions[index * 3 + 2] as number,
  ];
  const faces: Corners[] = [];
  const boxes = new Float64Array(faceCount * 6);
  let sizeSum = 0;
  const lo: [number, number, number] = [Infinity, Infinity, Infinity];
  for (let f = 0; f < faceCount; f++) {
    const c: Corners = [corner(triangles[f * 3] as number), corner(triangles[f * 3 + 1] as number), corner(triangles[f * 3 + 2] as number)];
    faces.push(c);
    for (let axis = 0; axis < 3; axis++) {
      const values = [c[0][axis] as number, c[1][axis] as number, c[2][axis] as number];
      const [min, max] = [Math.min(...values), Math.max(...values)];
      boxes[f * 6 + axis] = min;
      boxes[f * 6 + 3 + axis] = max;
      sizeSum += max - min;
      lo[axis] = Math.min(lo[axis] as number, min);
    }
  }
  const cell = faceCount > 0 && sizeSum > 0 ? (sizeSum / (faceCount * 3)) * 2 : 1;
  const grid = new Map<string, number[]>();
  /** Triangles spanning too many cells (a big face among small ones) are tested against everything instead of filling the grid. */
  const large: number[] = [];
  for (let f = 0; f < faceCount; f++) {
    const range = [0, 1, 2].map((axis) => [
      Math.floor(((boxes[f * 6 + axis] as number) - (lo[axis] as number)) / cell),
      Math.floor(((boxes[f * 6 + 3 + axis] as number) - (lo[axis] as number)) / cell),
    ]);
    const [rx, ry, rz] = range as [number[], number[], number[]];
    const span =
      ((rx[1] as number) - (rx[0] as number) + 1) *
      ((ry[1] as number) - (ry[0] as number) + 1) *
      ((rz[1] as number) - (rz[0] as number) + 1);
    if (span > MAX_CELLS_PER_FACE) {
      large.push(f);
      continue;
    }
    for (let i = rx[0] as number; i <= (rx[1] as number); i++) {
      for (let j = ry[0] as number; j <= (ry[1] as number); j++) {
        for (let k = rz[0] as number; k <= (rz[1] as number); k++) {
          const key = `${i},${j},${k}`;
          const bucket = grid.get(key);
          if (bucket === undefined) grid.set(key, [f]);
          else bucket.push(f);
        }
      }
    }
  }
  const tested = new Set<number>();
  const pairs: Array<readonly [number, number]> = [];
  let count = 0;
  const shares = (x: number, y: number): boolean => {
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) if (triangles[x * 3 + i] === triangles[y * 3 + j]) return true;
    return false;
  };
  const overlaps = (x: number, y: number): boolean =>
    [0, 1, 2].every(
      (axis) =>
        (boxes[x * 6 + axis] as number) <= (boxes[y * 6 + 3 + axis] as number) &&
        (boxes[y * 6 + axis] as number) <= (boxes[x * 6 + 3 + axis] as number),
    );
  const consider = (first: number, second: number): void => {
    const [x, y] = first < second ? [first, second] : [second, first];
    const id = x * faceCount + y;
    if (tested.has(id)) return;
    tested.add(id);
    if (shares(x, y) || !overlaps(x, y) || !trianglesCross(faces[x] as Corners, faces[y] as Corners)) return;
    count++;
    pairs.push([x, y]);
  };
  for (const bucket of grid.values()) {
    for (let i = 0; i < bucket.length; i++) for (let j = i + 1; j < bucket.length; j++) consider(bucket[i] as number, bucket[j] as number);
  }
  for (const big of large) for (let other = 0; other < faceCount; other++) if (other !== big) consider(big, other);
  pairs.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  return { count, pairs: pairs.slice(0, maxListed) };
}
