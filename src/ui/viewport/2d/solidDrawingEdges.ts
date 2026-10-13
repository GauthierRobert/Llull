// Pure outline edges (visible / hidden / cut; centre lines are not edges) of a solid's drawing, for picking, box
// selection and snapping.

import { chainSegments, type SegmentChain } from '@core/geometry/planeEdges';
import type { Segment2 } from '@core/geometry/viewProjection';
import { type DrawingPrimitive, drawingTolerance } from '@core/model/drawing';
import type { Vec2 } from '@core/model/types';
import { distance, projectOntoSegment } from '@lib/polygon';

type EdgeStyle = 'visible' | 'hidden' | 'cut';

const isEdgeStyle = (style: string): style is EdgeStyle => style === 'visible' || style === 'hidden' || style === 'cut';

function pushPath(into: Segment2[], points: ReadonlyArray<Vec2>, closed: boolean): void {
  for (let i = 0; i + 1 < points.length; i++) into.push([points[i] as Vec2, points[i + 1] as Vec2]);
  const first = points[0];
  const last = points[points.length - 1];
  if (closed && first && last) into.push([last, first]);
}

/** Grouped by line style (the technical view emits no arcs / circles). @pure */
function segmentsByStyle(primitives: ReadonlyArray<DrawingPrimitive>, tolerance: number): Map<EdgeStyle, Segment2[]> {
  const byStyle = new Map<EdgeStyle, Segment2[]>();
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
      segments.filter(([a, b]) => distance(a, b) > tolerance),
    );
  }
  return byStyle;
}

export function drawingSegments(primitives: ReadonlyArray<DrawingPrimitive>): Segment2[] {
  const byStyle = segmentsByStyle(primitives, drawingTolerance(primitives));
  return [...byStyle.values()].flat();
}

/** Infinity when none. @pure */
export function segmentsDistSq(segments: ReadonlyArray<Segment2>, point: Vec2): number {
  let best = Infinity;
  for (const [a, b] of segments) {
    best = Math.min(best, projectOntoSegment(point, a, b).distance ** 2);
  }
  return best;
}

/** Same-style chains joined where exactly two segments meet (a T-junction ends them); closed chains do not repeat the first point. @pure */
export function drawingChains(primitives: ReadonlyArray<DrawingPrimitive>): SegmentChain<Vec2>[] {
  const tolerance = drawingTolerance(primitives);
  return [...segmentsByStyle(primitives, tolerance).values()].flatMap((segments) => chainSegments(segments, tolerance, true));
}
