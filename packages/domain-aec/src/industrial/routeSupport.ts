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
