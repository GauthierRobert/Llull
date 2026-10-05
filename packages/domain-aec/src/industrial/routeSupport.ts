/**
 * Polyline routes of pipes and cable trays: parsing, repeated-point test, length.
 * @layer domain-aec
 * @pure
 */

import type { Vec3 } from '@core/model/types';
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

export const routeLength = (route: ReadonlyArray<Vec3>): number =>
  route.reduce((sum, point, index) => {
    const previous = route[index - 1];
    return previous
      ? sum + Math.hypot(point[0] - previous[0], point[1] - previous[1], point[2] - previous[2])
      : sum;
  }, 0);

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
  for (let index = 0; index + 1 < route.length; index++) {
    const [a, b] = [route[index] as Vec3, route[index + 1] as Vec3];
    const delta: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const length = Math.hypot(delta[0], delta[1], delta[2]);
    if (length > 0) {
      const t = Math.max(
        0,
        Math.min(
          1,
          ((point[0] - a[0]) * delta[0] +
            (point[1] - a[1]) * delta[1] +
            (point[2] - a[2]) * delta[2]) /
            (length * length),
        ),
      );
      const snapped: Vec3 = [a[0] + delta[0] * t, a[1] + delta[1] * t, a[2] + delta[2] * t];
      const distance = Math.hypot(
        point[0] - snapped[0],
        point[1] - snapped[1],
        point[2] - snapped[2],
      );
      if (best === null || distance < best.distance - 1e-9) {
        best = {
          point: snapped,
          distance,
          arc: travelled + t * length,
          segment: index,
          direction: [delta[0] / length, delta[1] / length, delta[2] / length],
        };
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
  for (let index = 0; index + 1 < route.length; index++) {
    const [a, b] = [route[index] as Vec3, route[index + 1] as Vec3];
    const delta: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const length = Math.hypot(delta[0], delta[1], delta[2]);
    if (length === 0) continue;
    const direction: Vec3 = [delta[0] / length, delta[1] / length, delta[2] / length];
    const t = Math.max(0, Math.min(1, (arc - travelled) / length));
    last = {
      point: [a[0] + delta[0] * t, a[1] + delta[1] * t, a[2] + delta[2] * t],
      direction,
      segment: index,
    };
    if (arc <= travelled + length) return last;
    travelled += length;
  }
  return last;
}

/** Arc length of every route point from the first (same length as `route`). */
export function arcLengths(route: ReadonlyArray<Vec3>): number[] {
  const arcs: number[] = [];
  let travelled = 0;
  route.forEach((point, index) => {
    const previous = route[index - 1];
    if (previous) {
      travelled += Math.hypot(
        point[0] - previous[0],
        point[1] - previous[1],
        point[2] - previous[2],
      );
    }
    arcs.push(travelled);
  });
  return arcs;
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
  for (let index = 0; index + 1 < route.length && travelled < arc; index++) {
    const [a, b] = [route[index] as Vec3, route[index + 1] as Vec3];
    const length = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    if (length === 0) continue;
    const used = Math.min(length, arc - travelled);
    if (Math.abs(b[2] - a[2]) / length <= RISER_SLOPE) span += used;
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
export const MIN_RISER_LENGTH = 500;

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
  for (let index = 0; index + 1 < route.length; index++) {
    const [a, b] = [route[index] as Vec3, route[index + 1] as Vec3];
    const length = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    const steep = length > 0 && Math.abs(b[2] - a[2]) / length > RISER_SLOPE;
    if (steep && open === null) open = index;
    if (!steep && length > 0) close(index);
  }
  close(route.length - 1);
  return runs;
}
