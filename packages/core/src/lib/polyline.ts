/** Arc-length helpers for open polylines of any dimension. */

type Coordinates = readonly number[];

/** Length of each consecutive segment of `points` (`points.length - 1` values). */
export function segmentLengths(points: ReadonlyArray<Coordinates>): number[] {
  return points.slice(1).map((point, i) => {
    const previous = points[i] as Coordinates;
    return Math.hypot(...point.map((value, axis) => value - (previous[axis] ?? 0)));
  });
}

/** Total length of the open polyline through `points`. */
export function polylineLength(points: ReadonlyArray<Coordinates>): number {
  return segmentLengths(points).reduce((sum, length) => sum + length, 0);
}
