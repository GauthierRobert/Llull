/** Exact rounded pocket outlines (07 FTR §5.5): a closed polygon with every vertex rounded by a tangent arc, as a `CurveSegment` chain. */

import type { CurveSegment } from '../model/curve';
import type { Vec2, Vec3 } from '../model/types';
import { arcGeometry, filletClosedPolygon, mapSegment, sampleProfile, segmentPoint, segmentSteps } from './curveSegments';
import { isValidPolygon, projectOntoSegment, toCounterClockwise } from '../lib/polygon';
import { dot3, len3, sub3 } from '../lib/vec3';
import { positiveSweep } from '../lib/angle';

export interface PocketOutline {
  readonly curves: readonly CurveSegment<Vec2>[];
  /** Tessellation of `curves` (what a mesh kernel extrudes). */
  readonly profile: readonly Vec2[];
}

const flat = (p: Vec3): Vec2 => [p[0], p[1]];

const lines = (points: readonly Vec2[]): CurveSegment<Vec2>[] =>
  points.map((point, index): CurveSegment<Vec2> => ({ type: 'line', points: [point, points[(index + 1) % points.length] as Vec2] }));

const flatten = (segment: CurveSegment<Vec3>): CurveSegment<Vec2> => mapSegment(segment, flat);

/**
 * Closed counter-clockwise chain of `outline` with every vertex rounded by `cornerRadius` (0 = sharp).
 * @failure fewer than 3 vertices / zero area, or a radius too large for an edge -> reason string
 */
export function roundedOutline(outline: readonly Vec2[], cornerRadius: number): PocketOutline | string {
  if (!isValidPolygon(outline)) return 'the outline needs at least 3 distinct vertices enclosing a non-zero area';
  const ccw = toCounterClockwise(outline);
  let curves: CurveSegment<Vec2>[];
  if (cornerRadius > 0) {
    const chain = filletClosedPolygon(
      ccw.map(([x, y]): Vec3 => [x, y, 0]),
      cornerRadius,
    );
    if (typeof chain === 'string') return chain;
    curves = chain.map(flatten);
  } else curves = lines(ccw);
  return { curves, profile: sampleProfile(curves) };
}

/** Distance from local point `p` to the chain `curves` (lines, circular arcs; ellipse and Bézier pieces by sampling). */
export function distanceToOutline(curves: readonly CurveSegment<Vec2>[], p: Vec2): number {
  let best = Infinity;
  for (const segment of curves) {
    if (segment.type === 'line') {
      best = Math.min(best, projectOntoSegment(p, segment.points[0], segment.points[1]).distance);
      continue;
    }
    if (segment.type !== 'arc') {
      const steps = segmentSteps(segment) * 4;
      for (let s = 0; s <= steps; s++) {
        const [x, y] = segmentPoint(segment, s / steps);
        best = Math.min(best, Math.hypot(x - p[0], y - p[1]));
      }
      continue;
    }
    const arc = arcGeometry(segment.points[0], segment.points[1], segment.points[2]);
    if (arc === null) continue;
    const relative = sub3([p[0], p[1], 0], arc.center);
    const angle = positiveSweep(Math.atan2(dot3(relative, arc.v), dot3(relative, arc.u)));
    const ends = [segment.points[0], segment.points[2]].map((end) => Math.hypot(end[0] - p[0], end[1] - p[1]));
    best = Math.min(best, angle <= arc.sweep ? Math.abs(len3(relative) - arc.radius) : Math.min(...ends));
  }
  return best;
}
