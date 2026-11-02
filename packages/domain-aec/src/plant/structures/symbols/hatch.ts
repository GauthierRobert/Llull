/** Hatch of a convex polygon: parallel lines along a direction, evenly spread across the polygon (06 STA plan symbol of a grating panel). Pure. */

import type { Vec2 } from '@core/model/types';

/**
 * Lines parallel to the unit vector `direction` across `outline` (convex), about `spacing` apart and at most `maxLines`, none on the outline itself.
 * @invariant empty for a degenerate polygon or a zero direction
 */
export function hatchLines(outline: ReadonlyArray<Vec2>, direction: Vec2, spacing: number, maxLines: number): Array<[Vec2, Vec2]> {
  const length = Math.hypot(direction[0], direction[1]);
  if (outline.length < 3 || length === 0 || !(spacing > 0) || maxLines < 1) return [];
  const d: Vec2 = [direction[0] / length, direction[1] / length];
  const normal: Vec2 = [-d[1], d[0]];
  const across = outline.map((p) => p[0] * normal[0] + p[1] * normal[1]);
  const [low, high] = [Math.min(...across), Math.max(...across)];
  const count = Math.min(maxLines, Math.floor((high - low) / spacing));
  if (count < 1) return [];
  const step = (high - low) / (count + 1);
  const lines: Array<[Vec2, Vec2]> = [];
  for (let k = 1; k <= count; k++) {
    const t = low + k * step;
    const along: Vec2[] = [];
    for (let i = 0; i < outline.length; i++) {
      const [a, b] = [outline[i] as Vec2, outline[(i + 1) % outline.length] as Vec2];
      const [ta, tb] = [across[i] as number, across[(i + 1) % outline.length] as number];
      if ((ta - t) * (tb - t) > 0 || ta === tb) continue;
      const s = (t - ta) / (tb - ta);
      along.push([a[0] + s * (b[0] - a[0]), a[1] + s * (b[1] - a[1])]);
    }
    if (along.length < 2) continue;
    const sorted = [...along].sort((p, q) => p[0] * d[0] + p[1] * d[1] - (q[0] * d[0] + q[1] * d[1]));
    lines.push([sorted[0] as Vec2, sorted[sorted.length - 1] as Vec2]);
  }
  return lines;
}
