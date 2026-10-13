/**
 * @layer ui/viewport/2d
 *
 * Edge geometry of a solid's drawing primitives — what the user sees as outline: visible, hidden
 * and cut edges (centre lines overshoot the part and are not edges). Pure helpers shared by
 * picking, box selection and snapping.
 */

import { drawingBounds, type DrawingPrimitive } from '@core/model/drawing';
import type { Vec2 } from '@core/model/types';
import { projectOntoSegment } from '@lib/polygon';

export type Segment = readonly [Vec2, Vec2];

/** Consecutive points joined at degree-2 vertices; a closed chain does not repeat its first point. */
export interface Chain {
  readonly points: Vec2[];
  readonly closed: boolean;
}

type EdgeStyle = 'visible' | 'hidden' | 'cut';

const isEdgeStyle = (style: string): style is EdgeStyle =>
  style === 'visible' || style === 'hidden' || style === 'cut';

/** Join tolerance of a drawing: a millionth of its extent. @pure */
export function drawingTolerance(primitives: ReadonlyArray<DrawingPrimitive>): number {
  const [minX, minY, maxX, maxY] = drawingBounds(primitives);
  return Math.max(maxX - minX, maxY - minY, 1) * 1e-6;
}

function pushPath(into: Segment[], points: ReadonlyArray<Vec2>, closed: boolean): void {
  for (let i = 0; i + 1 < points.length; i++) into.push([points[i] as Vec2, points[i + 1] as Vec2]);
  const first = points[0];
  const last = points[points.length - 1];
  if (closed && first && last) into.push([last, first]);
}

/** Edge segments of `primitives` grouped by line style; arcs / circles are not emitted by the technical view. @pure */
function segmentsByStyle(
  primitives: ReadonlyArray<DrawingPrimitive>,
  tolerance: number,
): Map<EdgeStyle, Segment[]> {
  const byStyle = new Map<EdgeStyle, Segment[]>();
  for (const primitive of primitives) {
    if (!isEdgeStyle(primitive.style)) continue;
    const segments = byStyle.get(primitive.style) ?? [];
    if (primitive.type === 'line') segments.push([primitive.a, primitive.b]);
    else if (primitive.type === 'polyline') pushPath(segments, primitive.points, false);
    else if (primitive.type === 'polygon') pushPath(segments, primitive.points, true);
    else continue;
    byStyle.set(primitive.style, segments);
  }
  for (const [style, segments] of byStyle) {
    byStyle.set(
      style,
      segments.filter(([a, b]) => Math.hypot(b[0] - a[0], b[1] - a[1]) > tolerance),
    );
  }
  return byStyle;
}

/** Every visible / hidden / cut edge segment of the drawing. @pure */
export function drawingSegments(primitives: ReadonlyArray<DrawingPrimitive>): Segment[] {
  const byStyle = segmentsByStyle(primitives, drawingTolerance(primitives));
  return [...byStyle.values()].flat();
}

/** Squared distance from `point` to the nearest of `segments` (Infinity when none). @pure */
export function segmentsDistSq(segments: ReadonlyArray<Segment>, point: Vec2): number {
  let best = Infinity;
  for (const [a, b] of segments) {
    best = Math.min(best, projectOntoSegment(point, a, b).distance ** 2);
  }
  return best;
}

/**
 * Chains of same-style edge segments, joined where exactly two segments meet; a vertex shared by
 * three or more (a T-junction) ends the chains. @pure
 */
export function drawingChains(primitives: ReadonlyArray<DrawingPrimitive>): Chain[] {
  const tolerance = drawingTolerance(primitives);
  const chains: Chain[] = [];
  for (const segments of segmentsByStyle(primitives, tolerance).values()) {
    chains.push(...chainSegments(segments, tolerance));
  }
  return chains;
}

function chainSegments(segments: ReadonlyArray<Segment>, tolerance: number): Chain[] {
  const keyOf = ([x, y]: Vec2): string =>
    `${Math.round(x / tolerance)},${Math.round(y / tolerance)}`;
  const meeting = new Map<string, number[]>();
  segments.forEach((segment, index) => {
    for (const end of segment) {
      const key = keyOf(end);
      meeting.set(key, [...(meeting.get(key) ?? []), index]);
    }
  });
  const used = new Set<number>();
  /** The one unused segment continuing through `point`, if exactly two segments meet there. */
  const continuation = (point: Vec2, from: number): number | undefined => {
    const ids = meeting.get(keyOf(point)) ?? [];
    return ids.length === 2 ? ids.find((id) => id !== from && !used.has(id)) : undefined;
  };
  const otherEnd = (index: number, point: Vec2): Vec2 => {
    const [a, b] = segments[index] as Segment;
    return keyOf(a) === keyOf(point) ? b : a;
  };

  const chains: Chain[] = [];
  segments.forEach((start, startIndex) => {
    if (used.has(startIndex)) return;
    used.add(startIndex);
    const points: Vec2[] = [start[0], start[1]];
    let closed = false;
    let current = startIndex;
    for (let next = continuation(start[1], current); next !== undefined; ) {
      const point = otherEnd(next, points[points.length - 1] as Vec2);
      used.add(next);
      current = next;
      if (keyOf(point) === keyOf(points[0] as Vec2)) {
        closed = true;
        break;
      }
      points.push(point);
      next = continuation(point, current);
    }
    current = startIndex;
    for (let prev = closed ? undefined : continuation(start[0], current); prev !== undefined; ) {
      const point = otherEnd(prev, points[0] as Vec2);
      used.add(prev);
      current = prev;
      points.unshift(point);
      prev = continuation(point, current);
    }
    chains.push({ points, closed });
  });
  return chains;
}
