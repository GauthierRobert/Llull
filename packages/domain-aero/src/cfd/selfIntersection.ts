/** Self-intersection of an indexed triangle surface (TECHNICAL_SPEC §5.1 step 5): sweep-and-prune broad phase, edge-pierces-triangle narrow phase. */

import type { Vec3 } from '@core/model/types';
import { segmentPiercesTriangle } from '@core/geometry/triangleQueries';
import type { IndexedSurface } from './weld';
import { MAX_REPORTED_POINTS, surfaceBounds } from './topology';

/** Above this many triangles the test is skipped (reported as not run) to keep `cfd_prepare` interactive. */
export const MAX_INTERSECTION_TRIANGLES = 200_000;

export interface IntersectionReport {
  /** Intersecting triangle pairs found (not counting pairs that share a vertex). */
  readonly pairs: number;
  /** Up to `MAX_REPORTED_POINTS` pairs: triangle indices and the crossing point. */
  readonly examples: ReadonlyArray<{ readonly triangles: readonly [number, number]; readonly at: Vec3 }>;
}

type Corner = readonly [Vec3, Vec3, Vec3];

const cornersOf = ({ vertices, triangles }: IndexedSurface, t: number): Corner => {
  const at = (k: number): Vec3 => {
    const v = (triangles[t * 3 + k] ?? 0) * 3;
    return [vertices[v] ?? 0, vertices[v + 1] ?? 0, vertices[v + 2] ?? 0];
  };
  return [at(0), at(1), at(2)];
};

function crossing(first: Corner, second: Corner): Vec3 | null {
  for (let k = 0; k < 3; k++) {
    const hit =
      segmentPiercesTriangle(first[k] as Vec3, first[(k + 1) % 3] as Vec3, second) ??
      segmentPiercesTriangle(second[k] as Vec3, second[(k + 1) % 3] as Vec3, first);
    if (hit !== null) return hit;
  }
  return null;
}

/**
 * @invariant pairs that share a welded vertex are skipped (neighbours); coplanar overlaps are not detected
 * @failure more than MAX_INTERSECTION_TRIANGLES triangles -> null (not run)
 */
export function findSelfIntersections(surface: IndexedSurface): IntersectionReport | null {
  const count = Math.floor(surface.triangles.length / 3);
  if (count > MAX_INTERSECTION_TRIANGLES) return null;
  const { min, max } = surfaceBounds(surface);
  const axis = [0, 1, 2].reduce((best, a) => ((max[a] ?? 0) - (min[a] ?? 0) > (max[best] ?? 0) - (min[best] ?? 0) ? a : best), 0);
  const lows = new Float64Array(count * 3);
  const highs = new Float64Array(count * 3);
  for (let t = 0; t < count; t++)
    for (let a = 0; a < 3; a++) {
      const values = [0, 1, 2].map((k) => surface.vertices[(surface.triangles[t * 3 + k] ?? 0) * 3 + a] ?? 0);
      lows[t * 3 + a] = Math.min(...values);
      highs[t * 3 + a] = Math.max(...values);
    }
  const order = Array.from({ length: count }, (_, t) => t).sort((p, q) => (lows[p * 3 + axis] ?? 0) - (lows[q * 3 + axis] ?? 0) || p - q);
  const examples: Array<{ triangles: [number, number]; at: Vec3 }> = [];
  let pairs = 0;
  for (let i = 0; i < order.length; i++) {
    const first = order[i] as number;
    const reach = highs[first * 3 + axis] ?? 0;
    for (let j = i + 1; j < order.length; j++) {
      const second = order[j] as number;
      if ((lows[second * 3 + axis] ?? 0) > reach) break;
      if (
        [0, 1, 2].some(
          (a) => (lows[second * 3 + a] ?? 0) > (highs[first * 3 + a] ?? 0) || (highs[second * 3 + a] ?? 0) < (lows[first * 3 + a] ?? 0),
        )
      )
        continue;
      const shared = [0, 1, 2].some((k) => [0, 1, 2].some((m) => surface.triangles[first * 3 + k] === surface.triangles[second * 3 + m]));
      if (shared) continue;
      const at = crossing(cornersOf(surface, first), cornersOf(surface, second));
      if (at === null) continue;
      pairs++;
      if (examples.length < MAX_REPORTED_POINTS) examples.push({ triangles: first < second ? [first, second] : [second, first], at });
    }
  }
  return { pairs, examples };
}
