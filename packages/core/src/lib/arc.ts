/**
 * `count` points on the circle of `radius` about `center`, starting just after `startAngle` and
 * ending at `startAngle + sweep` (radians, CCW for positive sweep).
 *
 * @layer lib
 * @pure
 */
export function sampleArc(
  center: readonly [number, number],
  radius: number,
  startAngle: number,
  sweep: number,
  count: number,
): Array<readonly [number, number]> {
  return Array.from({ length: count }, (_, i): readonly [number, number] => {
    const t = startAngle + (sweep * (i + 1)) / count;
    return [center[0] + radius * Math.cos(t), center[1] + radius * Math.sin(t)];
  });
}
