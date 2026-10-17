/** Corner relief: a square notch cut at a right-angle outline vertex of a flat. */

import type { Vec2 } from '@core/model/types';
import { signedArea } from '@lib/polygon';
import { add2, dot2, normalize2, scale2, sub2 } from '@lib/vec2';
import { EPS, isSimplePolygon } from './geometry2d';

export interface CornerNotch {
  readonly outline: Vec2[];
  /** The removed square (either winding). */
  readonly square: Vec2[];
}

/**
 * Outline with the convex right-angle vertex `index` replaced by a size x size square notch.
 * @failure reflex or non-right-angle vertex, an adjacent edge not longer than `size`, or a non-simple result -> null
 */
export function cornerNotch(outline: readonly Vec2[], index: number, size: number): CornerNotch | null {
  const n = outline.length;
  const corner = outline[index] as Vec2;
  const toBefore = sub2(outline[(index + n - 1) % n] as Vec2, corner);
  const toAfter = sub2(outline[(index + 1) % n] as Vec2, corner);
  if (Math.hypot(toBefore[0], toBefore[1]) <= size + EPS || Math.hypot(toAfter[0], toAfter[1]) <= size + EPS) return null;
  const [eBefore, eAfter] = [normalize2(toBefore), normalize2(toAfter)];
  if (Math.abs(dot2(eBefore, eAfter)) > 1e-6 || eAfter[0] * eBefore[1] - eAfter[1] * eBefore[0] <= 0) return null;
  const a = add2(corner, scale2(eBefore, size));
  const c = add2(corner, scale2(eAfter, size));
  const b = add2(a, scale2(eAfter, size));
  const result = outline.flatMap((point, i): Vec2[] => (i === index ? [a, b, c] : [point]));
  return isSimplePolygon(result) ? { outline: result, square: [corner, c, b, a] } : null;
}

/** Length of the part of segment a-b inside the closed convex polygon (Cyrus-Beck clipping; edge contact counts). */
export function segmentLengthInside(polygon: readonly Vec2[], a: Vec2, b: Vec2): number {
  const sign = signedArea(polygon) >= 0 ? 1 : -1;
  const direction = sub2(b, a);
  let [enter, leave] = [0, 1];
  for (let i = 0; i < polygon.length; i++) {
    const p = polygon[i] as Vec2;
    const edge = sub2(polygon[(i + 1) % polygon.length] as Vec2, p);
    const inward: Vec2 = [-sign * edge[1], sign * edge[0]];
    const [numerator, denominator] = [dot2(sub2(p, a), inward), dot2(direction, inward)];
    if (Math.abs(denominator) < 1e-12) {
      if (numerator > 1e-9) return 0;
      continue;
    }
    const t = numerator / denominator;
    if (denominator > 0) enter = Math.max(enter, t);
    else leave = Math.min(leave, t);
  }
  return leave > enter ? (leave - enter) * Math.hypot(direction[0], direction[1]) : 0;
}
