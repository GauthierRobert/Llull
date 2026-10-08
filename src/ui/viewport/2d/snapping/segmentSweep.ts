/**
 * @layer ui/viewport/2d
 *
 * Pairwise segment intersections via sweep-and-prune on the x axis: only pairs whose x and y
 * extents overlap reach the exact test, so scenes with thousands of segments stay near-linear.
 */

import { segmentIntersection, type Segment } from './geometry';

const EPSILON = 1e-9;

/**
 * Every intersection point between two distinct segments of `segments`.
 * @pure
 * @invariant same point set as testing all i<j pairs with `segmentIntersection`
 */
export function allSegmentIntersections(segments: ReadonlyArray<Segment>): Array<[number, number]> {
  const minX = segments.map(([ax, , bx]) => Math.min(ax, bx) - EPSILON);
  const maxX = segments.map(([ax, , bx]) => Math.max(ax, bx) + EPSILON);
  const minY = segments.map(([, ay, , by]) => Math.min(ay, by) - EPSILON);
  const maxY = segments.map(([, ay, , by]) => Math.max(ay, by) + EPSILON);
  const byMinX = segments.map((_, index) => index).sort((a, b) => (minX[a] ?? 0) - (minX[b] ?? 0));

  const points: Array<[number, number]> = [];
  for (let order = 0; order < byMinX.length; order++) {
    const i = byMinX[order] as number;
    const first = segments[i] as Segment;
    for (let next = order + 1; next < byMinX.length; next++) {
      const j = byMinX[next] as number;
      if ((minX[j] as number) > (maxX[i] as number)) break;
      if ((minY[j] as number) > (maxY[i] as number) || (maxY[j] as number) < (minY[i] as number)) {
        continue;
      }
      const point = segmentIntersection(...first, ...(segments[j] as Segment));
      if (point) points.push(point);
    }
  }
  return points;
}
