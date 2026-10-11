/**
 * Rectangle clipping of plan linework in paper millimetres (Liang-Barsky).
 * @layer domain-aec/civil
 * @pure
 */

import type { Vec2 } from '@core/model/types';

export interface ClipRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export function insideRect([x, y]: Vec2, rect: ClipRect): boolean {
  return x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height;
}

/** The part of segment a-b inside `rect`, or null. */
export function clipSegment(a: Vec2, b: Vec2, rect: ClipRect): [Vec2, Vec2] | null {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const edges: ReadonlyArray<readonly [number, number]> = [
    [-dx, a[0] - rect.x],
    [dx, rect.x + rect.width - a[0]],
    [-dy, a[1] - rect.y],
    [dy, rect.y + rect.height - a[1]],
  ];
  let t0 = 0;
  let t1 = 1;
  for (const [p, q] of edges) {
    if (p === 0) {
      if (q < 0) return null;
      continue;
    }
    const t = q / p;
    if (p < 0) {
      if (t > t1) return null;
      t0 = Math.max(t0, t);
    } else {
      if (t < t0) return null;
      t1 = Math.min(t1, t);
    }
  }
  return [
    [a[0] + t0 * dx, a[1] + t0 * dy],
    [a[0] + t1 * dx, a[1] + t1 * dy],
  ];
}

/** Connected runs of `points` (optionally closed) that lie inside `rect`. */
export function clipPolyline(
  points: ReadonlyArray<Vec2>,
  closed: boolean,
  rect: ClipRect,
): Vec2[][] {
  const runs: Vec2[][] = [];
  const count = closed ? points.length : points.length - 1;
  let open: Vec2[] | null = null;
  let previousEnd: Vec2 | null = null;
  for (let index = 0; index < count; index++) {
    const a = points[index];
    const b = points[(index + 1) % points.length];
    const clipped = a && b ? clipSegment(a, b, rect) : null;
    if (!clipped) {
      open = null;
      previousEnd = null;
      continue;
    }
    const [start, end] = clipped;
    const continues =
      open !== null &&
      previousEnd !== null &&
      Math.hypot(previousEnd[0] - start[0], previousEnd[1] - start[1]) < 1e-6;
    if (open !== null && continues) {
      open.push(end);
    } else {
      open = [start, end];
      runs.push(open);
    }
    previousEnd = end;
  }
  return runs;
}
