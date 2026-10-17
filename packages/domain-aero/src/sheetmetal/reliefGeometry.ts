/** Relief notches: where a bend ends on a free stretch of its parent's edge, and the outline with a rectangular notch cut beside it. */

import type { Vec2 } from '@core/model/types';
import type { Seg2 } from '@core/model/sheetMetal';
import { add2, perp2, scale2, sub2, dot2, normalize2 } from '@lib/vec2';
import { EPS, dedupe, isSimplePolygon } from './geometry2d';

export interface BendEnd {
  /** Index of the outline edge a -> b the bend lies on. */
  readonly edge: number;
  readonly a: Vec2;
  readonly b: Vec2;
  /** Unit direction a -> b. */
  readonly along: Vec2;
  readonly edgeLength: number;
  /** Position of the bend end along the edge from a. */
  readonly at: number;
  /** Free edge length beyond the bend end (towards b for 'start' = p, towards a for 'end' = q). */
  readonly free: number;
}

/** Edge of `outline` carrying the bend line, and the free edge length beyond one bend end; null when the line is on no edge. */
export function bendEnd(outline: readonly Vec2[], line: Seg2, end: 'start' | 'end'): BendEnd | null {
  const [p, q] = line;
  for (let edge = 0; edge < outline.length; edge++) {
    const a = outline[edge] as Vec2;
    const b = outline[(edge + 1) % outline.length] as Vec2;
    const edgeLength = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const along = normalize2(sub2(b, a));
    const offLine = (point: Vec2): number => Math.abs(dot2(sub2(point, a), perp2(along)));
    if (offLine(p) > 1e-6 || offLine(q) > 1e-6) continue;
    const [sP, sQ] = [dot2(sub2(p, a), along), dot2(sub2(q, a), along)];
    if (sP < sQ) continue;
    const at = end === 'start' ? sP : sQ;
    return { edge, a, b, along, edgeLength, at, free: end === 'start' ? edgeLength - sP : sQ };
  }
  return null;
}

/**
 * Outline with a width x depth rectangular notch cut into the edge beside a bend end.
 * @failure notch touching both edge ends, a touched corner whose neighbouring edge is not perpendicular or is shorter than the depth, or a non-simple result -> null
 */
export function notchOutline(outline: readonly Vec2[], end: BendEnd, side: 'start' | 'end', width: number, depth: number): Vec2[] | null {
  const n = outline.length;
  const inward = perp2(end.along);
  const [u0, u1] = side === 'start' ? [end.at, end.at + width] : [end.at - width, end.at];
  if (u0 < -1e-9 || u1 > end.edgeLength + 1e-9) return null;
  const touchA = u0 <= 1e-9;
  const touchB = u1 >= end.edgeLength - 1e-9;
  if (touchA && touchB) return null;
  const onEdge = (u: number): Vec2 => add2(end.a, scale2(end.along, u));
  const deep = (u: number): Vec2 => add2(onEdge(u), scale2(inward, depth));
  const cornerOk = (neighbour: Vec2, corner: Vec2): boolean => {
    const leg = sub2(neighbour, corner);
    return Math.abs(dot2(normalize2(leg), end.along)) < 1e-6 && Math.hypot(leg[0], leg[1]) > depth + EPS;
  };
  if (touchA && !cornerOk(outline[(end.edge + n - 1) % n] as Vec2, end.a)) return null;
  if (touchB && !cornerOk(outline[(end.edge + 2) % n] as Vec2, end.b)) return null;
  const out: Vec2[] = [];
  outline.forEach((point, index) => {
    if (index === (end.edge + 1) % n && touchB) return;
    if (index !== end.edge) {
      out.push(point);
      return;
    }
    if (touchA) out.push(deep(0));
    else out.push(end.a, onEdge(u0), deep(u0));
    if (touchB) out.push(deep(end.edgeLength));
    else out.push(deep(u1), onEdge(u1));
  });
  const result = dedupe(out);
  return isSimplePolygon(result) ? result : null;
}
