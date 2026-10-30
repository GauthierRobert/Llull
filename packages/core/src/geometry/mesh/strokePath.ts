/** Stamp centres along a path for `sculpt_mesh` `along` (07 MSH FR-MSH-18): a polyline resampled every `spacing` of arc length, the first stamp at its start. */

import type { Vec3 } from '../../model/vectors';

/** Most stamps one stroke may have: each stamp visits every vertex, so a stroke of millions of stamps would never end. */
export const MAX_STROKE_STAMPS = 10_000;

/**
 * Points of the open polyline `path` at arc lengths 0, spacing, 2 spacing, ... up to its length (the end itself only when it falls on a multiple). Zero-length
 * segments are skipped. Null when the stroke would have more than MAX_STROKE_STAMPS stamps, or `path` has no length.
 */
export function stampsAlong(path: ReadonlyArray<Vec3>, spacing: number): Vec3[] | null {
  const lengths = path.slice(1).map((p, i) => {
    const q = path[i] as Vec3;
    return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
  });
  const total = lengths.reduce((sum, length) => sum + length, 0);
  if (!(total > 0) || !(spacing > 0) || Math.floor(total / spacing) + 1 > MAX_STROKE_STAMPS) return null;
  const stamps: Vec3[] = [];
  let segment = 0;
  let before = 0;
  for (let k = 0; k * spacing <= total; k++) {
    const arc = k * spacing;
    while (segment < lengths.length - 1 && before + (lengths[segment] as number) < arc) before += lengths[segment++] as number;
    const [a, b] = [path[segment] as Vec3, path[segment + 1] as Vec3];
    const length = lengths[segment] as number;
    const s = length === 0 ? 0 : Math.min(1, Math.max(0, (arc - before) / length));
    stamps.push([a[0] + s * (b[0] - a[0]), a[1] + s * (b[1] - a[1]), a[2] + s * (b[2] - a[2])]);
  }
  return stamps;
}
