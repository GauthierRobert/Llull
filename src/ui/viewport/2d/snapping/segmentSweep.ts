// Pairwise segment intersections by x sweep-and-prune: only x/y-overlapping pairs reach the exact test (near-linear).

import { segmentIntersection } from '@lib/polygon';
import type { Segment } from './geometry';

const EPSILON = 1e-9;

/** @invariant same points as testing every i<j pair with `segmentIntersection` */
export function allSegmentIntersections(segments: ReadonlyArray<Segment>): Array<[number, number]> {
  const minX = segments.map(([ax, , bx]) => Math.min(ax, bx) - EPSILON);
  const maxX = segments.map(([ax, , bx]) => Math.max(ax, bx) + EPSILON);
  const minY = segments.map(([, ay, , by]) => Math.min(ay, by) - EPSILON);
  const maxY = segments.map(([, ay, , by]) => Math.max(ay, by) + EPSILON);
  const byMinX = segments.map((_, index) => index).sort((a, b) => (minX[a] ?? 0) - (minX[b] ?? 0));

  const points: Array<[number, number]> = [];
  for (let order = 0; order < byMinX.length; order++) {
    const i = byMinX[order] as number;
    const [ax, ay, bx, by] = segments[i] as Segment;
    for (let next = order + 1; next < byMinX.length; next++) {
      const j = byMinX[next] as number;
      if ((minX[j] as number) > (maxX[i] as number)) break;
      if ((minY[j] as number) > (maxY[i] as number) || (maxY[j] as number) < (minY[i] as number)) continue;
      const [cx, cy, dx, dy] = segments[j] as Segment;
      const point = segmentIntersection([ax, ay], [bx, by], [cx, cy], [dx, dy]);
      if (point) points.push([point[0], point[1]]);
    }
  }
  return points;
}
