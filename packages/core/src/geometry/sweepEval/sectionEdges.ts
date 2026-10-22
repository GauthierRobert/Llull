/** Section boundary as single-span (Bézier-form) rational edges in section coordinates: the pieces the exact solid keeps as B-rep edges. */

import type { CurveSegment } from '../../model/curve';
import type { SweepEntity, Vec2 } from '../../model/types';
import { arcGeometry } from '../curveSegments';
import { ringCurves } from '../sectionRing';

/** One boundary edge: a Bézier span of `degree` with `degree + 1` poles (and weights when rational, e.g. an arc piece of at most a quarter turn). */
export interface SectionEdge {
  readonly degree: number;
  readonly poles: Vec2[];
  readonly weights?: number[];
}

/** An arc given by centre, radius, start axis, perpendicular axis and sweep, split into rational quadratic pieces of at most 90 degrees. */
function conicArc(center: Vec2, radius: number, u: Vec2, v: Vec2, sweep: number): SectionEdge[] {
  const pieces = Math.max(1, Math.ceil(Math.abs(sweep) / (Math.PI / 2) - 1e-9));
  const step = sweep / pieces;
  const half = step / 2;
  const at = (angle: number, reach: number): Vec2 => [
    center[0] + reach * (Math.cos(angle) * u[0] + Math.sin(angle) * v[0]),
    center[1] + reach * (Math.cos(angle) * u[1] + Math.sin(angle) * v[1]),
  ];
  return Array.from({ length: pieces }, (_, j) => ({
    degree: 2,
    poles: [at(j * step, radius), at(j * step + half, radius / Math.cos(half)), at((j + 1) * step, radius)],
    weights: [1, Math.cos(half), 1],
  }));
}

function segmentEdges(segment: CurveSegment<Vec2>): SectionEdge[] | null {
  const pts = segment.points;
  if (segment.type === 'line') return [{ degree: 1, poles: [pts[0] as Vec2, pts[1] as Vec2] }];
  if (segment.type === 'bezier') return [{ degree: 3, poles: pts.map((p): Vec2 => [p[0], p[1]]) }];
  const geometry = arcGeometry(pts[0] as Vec2, pts[1] as Vec2, pts[2] as Vec2);
  if (geometry === null) return null;
  const { center, radius, u, v, sweep } = geometry;
  return conicArc([center[0], center[1]], radius, [u[0], u[1]], [v[0], v[1]], sweep);
}

/**
 * Edges of a constant section: a circle as four quarter conics, a profile as its exact curves (or its polygon sides).
 * @failure a hollow circle (bore), a degenerate arc -> null
 */
export function constantEdges(section: SweepEntity['section']): SectionEdge[] | null {
  if (section.shape === 'circle') {
    if (section.innerRadius !== undefined) return null;
    return conicArc([0, 0], section.radius, [1, 0], [0, 1], 2 * Math.PI);
  }
  const { profile, curves } = section;
  const segments: ReadonlyArray<CurveSegment<Vec2>> =
    curves ?? profile.map((p, i) => ({ type: 'line' as const, points: [p, profile[(i + 1) % profile.length] as Vec2] as const }));
  const edges: SectionEdge[] = [];
  for (const segment of segments) {
    const made = segmentEdges(segment);
    if (made === null) return null;
    edges.push(...made);
  }
  return edges;
}

/** Edges of a station ring: the cubic Bézier of each ring point. */
export function ringEdges(ring: ReadonlyArray<Vec2>): SectionEdge[] {
  return ringCurves(ring).flatMap((segment) => segmentEdges(segment) ?? []);
}
