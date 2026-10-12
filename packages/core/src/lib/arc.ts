/**
 * Arc sampling on a circle (or an axis-aligned ellipse with `radiusY`) about `center`.
 *
 * @layer lib
 * @pure
 */

/** The point at `angle` (radians) on the circle of `radius` about `center`. */
export function polar(
  center: readonly [number, number],
  radius: number,
  angle: number,
): [number, number] {
  return [center[0] + radius * Math.cos(angle), center[1] + radius * Math.sin(angle)];
}

/**
 * `segments + 1` points from `startAngle` to `startAngle + sweep` inclusive (radians, CCW for a
 * positive sweep), evenly spaced in angle.
 */
export function arcPolyline(
  center: readonly [number, number],
  radius: number,
  startAngle: number,
  sweep: number,
  segments: number,
  radiusY = radius,
): Array<[number, number]> {
  return Array.from({ length: segments + 1 }, (_, i): [number, number] => {
    const t = startAngle + (sweep * i) / segments;
    return [center[0] + radius * Math.cos(t), center[1] + radiusY * Math.sin(t)];
  });
}

/**
 * `count` points on the circle of `radius` about `center`, starting just after `startAngle` and
 * ending at `startAngle + sweep` (radians, CCW for positive sweep).
 */
export function sampleArc(
  center: readonly [number, number],
  radius: number,
  startAngle: number,
  sweep: number,
  count: number,
): Array<readonly [number, number]> {
  return arcPolyline(center, radius, startAngle, sweep, count).slice(1);
}

/** `segments` points of the full circle (first at angle 0, CCW, not closed). */
export function circlePolygon(
  center: readonly [number, number],
  radius: number,
  segments: number,
): Array<[number, number]> {
  return arcPolyline(center, radius, 0, 2 * Math.PI, segments).slice(0, segments);
}
