/**
 * Hatch pattern lines: parallel lines clipped to a region (even-odd over all loops).
 * @layer lib
 * @pure
 */

type Point = readonly [number, number];

/**
 * Segments of lines at `angle` (radians), `spacing` apart, inside the region bounded by `loops`
 * (outer boundary + holes, even-odd). Empty for degenerate input or spacing <= 0.
 */
export function hatchSegments(
  loops: ReadonlyArray<ReadonlyArray<Point>>,
  angle: number,
  spacing: number,
): Array<[[number, number], [number, number]]> {
  if (!(spacing > 0) || loops.every((loop) => loop.length < 3)) return [];
  const [cos, sin] = [Math.cos(angle), Math.sin(angle)];
  // Rotate into a frame where hatch lines are horizontal (v = constant).
  const toLocal = ([x, y]: Point): [number, number] => [x * cos + y * sin, -x * sin + y * cos];
  const toWorld = (u: number, v: number): [number, number] => [
    u * cos - v * sin,
    u * sin + v * cos,
  ];
  const local = loops.map((loop) => loop.map(toLocal));
  const vs = local.flatMap((loop) => loop.map(([, v]) => v));
  const [low, high] = [Math.min(...vs), Math.max(...vs)];
  const segments: Array<[[number, number], [number, number]]> = [];
  for (let v = Math.ceil(low / spacing) * spacing; v <= high; v += spacing) {
    const crossings: number[] = [];
    for (const loop of local) {
      loop.forEach((a, index) => {
        const b = loop[(index + 1) % loop.length] as [number, number];
        if ((a[1] <= v && b[1] > v) || (b[1] <= v && a[1] > v)) {
          crossings.push(a[0] + ((v - a[1]) / (b[1] - a[1])) * (b[0] - a[0]));
        }
      });
    }
    crossings.sort((a, b) => a - b);
    for (let index = 0; index + 1 < crossings.length; index += 2) {
      const [from, to] = [crossings[index] as number, crossings[index + 1] as number];
      if (to - from > 1e-9) segments.push([toWorld(from, v), toWorld(to, v)]);
    }
  }
  return segments;
}
