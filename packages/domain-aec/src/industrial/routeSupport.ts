/**
 * Polyline routes of pipes and cable trays: parsing, repeated-point test, length.
 * @layer domain-aec
 * @pure
 */

import type { Vec3 } from '@core/model/types';
import { add3, dot3, scale3, sub3 } from '@lib/vec3';
import { toVec3 } from './memberSupport';

/** Route as Vec3 points; null unless there are at least 2 well-formed [x, y, z] points. */
export function parseRoute(points: ReadonlyArray<unknown>): Vec3[] | null {
  const route = points.map(toVec3);
  return route.length >= 2 && route.every((point) => point !== null) ? (route as Vec3[]) : null;
}

export const hasRepeatedPoint = (route: ReadonlyArray<Vec3>): boolean =>
  route.some((point, index) => {
    const previous = route[index - 1];
    return (
      previous !== undefined &&
      point[0] === previous[0] &&
      point[1] === previous[1] &&
      point[2] === previous[2]
    );
  });

export const routeLength = (route: ReadonlyArray<Vec3>): number => arcLengths(route).at(-1) ?? 0;

interface Segment {
  readonly a: Vec3;
  readonly delta: Vec3;
  readonly length: number;
  /** Unit direction; meaningless for a zero-length segment. */
  readonly direction: Vec3;
}

/** Consecutive point pairs of `route` (zero-length ones included). */
function segmentsOf(route: ReadonlyArray<Vec3>): Segment[] {
  return route.slice(1).map((b, index): Segment => {
    const a = route[index] as Vec3;
    const delta = sub3(b, a);
    const length = Math.hypot(...delta);
    return {
      a,
      delta,
      length,
      direction: [delta[0] / length, delta[1] / length, delta[2] / length],
    };
  });
}

/** Nearest point of a polyline route to `point`. */
export interface RouteSnap {
  readonly point: Vec3;
  /** Distance from `point` to the route. */
  readonly distance: number;
  /** Arc length along the route from its first point to `point`. */
  readonly arc: number;
  /** Index of the segment the point lies on. */
  readonly segment: number;
  /** Unit direction of that segment. */
  readonly direction: Vec3;
}

/**
 * Snaps `point` onto the nearest segment of `route` (first of equals wins).
 * @failure route with fewer than 2 points -> null
 */
export function nearestOnRoute(route: ReadonlyArray<Vec3>, point: Vec3): RouteSnap | null {
  let best: RouteSnap | null = null;
  let travelled = 0;
  for (const [index, { a, delta, length, direction }] of segmentsOf(route).entries()) {
    if (length > 0) {
      const t = Math.max(0, Math.min(1, dot3(sub3(point, a), delta) / (length * length)));
      const snapped = add3(a, scale3(delta, t));
      const distance = Math.hypot(...sub3(point, snapped));
      if (best === null || distance < best.distance - 1e-9) {
        best = { point: snapped, distance, arc: travelled + t * length, segment: index, direction };
      }
    }
    travelled += length;
  }
  return best;
}

/** Point and segment direction at arc length `arc` of `route` (clamped to its ends). */
export function pointAtArc(
  route: ReadonlyArray<Vec3>,
  arc: number,
): { point: Vec3; direction: Vec3; segment: number } | null {
  let travelled = 0;
  let last: { point: Vec3; direction: Vec3; segment: number } | null = null;
  for (const [index, { a, delta, length, direction }] of segmentsOf(route).entries()) {
    if (length === 0) continue;
    const t = Math.max(0, Math.min(1, (arc - travelled) / length));
    last = { point: add3(a, scale3(delta, t)), direction, segment: index };
    if (arc <= travelled + length) return last;
    travelled += length;
  }
  return last;
}

/** Arc length of every route point from the first (same length as `route`). */
export function arcLengths(route: ReadonlyArray<Vec3>): number[] {
  let travelled = 0;
  return route.map((point, index) => {
    const previous = route[index - 1];
    if (previous) travelled += Math.hypot(...sub3(point, previous));
    return travelled;
  });
}

/** Segments steeper than this (|dz| / length) are risers: no shoe or hanger sits on them and their length is not a span. */
export const RISER_SLOPE = 0.7;

/**
 * Span coordinate at arc length `arc`: the arc length travelled on segments that are not risers
 * (a vertical pipe does not sag, so its length adds no span).
 */
export function spanCoordinate(route: ReadonlyArray<Vec3>, arc: number): number {
  let travelled = 0;
  let span = 0;
  for (const { delta, length } of segmentsOf(route)) {
    if (travelled >= arc) break;
    if (length === 0) continue;
    if (Math.abs(delta[2]) / length <= RISER_SLOPE) span += Math.min(length, arc - travelled);
    travelled += length;
  }
  return span;
}

/** A run of consecutive riser segments: from `startArc` to `endArc` along the route, mm. */
export interface RiserRun {
  readonly startArc: number;
  readonly endArc: number;
  /** Axis length of the run, mm. */
  readonly length: number;
  /** First and last point of the run. */
  readonly from: Vec3;
  readonly to: Vec3;
}

/** Risers shorter than this are fittings (offsets, drops to a nozzle), not checked as risers, mm. */
const MIN_RISER_LENGTH = 500;

/** Maximal runs of consecutive riser segments (|dz| / length > RISER_SLOPE) of at least MIN_RISER_LENGTH. */
export function riserRuns(route: ReadonlyArray<Vec3>): RiserRun[] {
  const arcs = arcLengths(route);
  const runs: RiserRun[] = [];
  let open: number | null = null;
  const close = (toIndex: number): void => {
    if (open === null) return;
    const fromIndex = open;
    open = null;
    const [startArc, endArc] = [arcs[fromIndex] as number, arcs[toIndex] as number];
    if (endArc - startArc < MIN_RISER_LENGTH) return;
    runs.push({
      startArc,
      endArc,
      length: endArc - startArc,
      from: route[fromIndex] as Vec3,
      to: route[toIndex] as Vec3,
    });
  };
  segmentsOf(route).forEach(({ delta, length }, index) => {
    const steep = length > 0 && Math.abs(delta[2]) / length > RISER_SLOPE;
    if (steep && open === null) open = index;
    if (!steep && length > 0) close(index);
  });
  close(route.length - 1);
  return runs;
}
