/**
 * Sketch outlines as chains of planar segments (03 WRP): a segment is a straight line or a 2D NURBS (Bezier, rational arc), whatever the sketch entity
 * was made of. Wrap and emboss map these through a face chart; affine charts keep every segment exact.
 */

import type { CurveSegment } from '../model/curve';
import type { Vec2, Vec3 } from '../model/vectors';
import { arc2, bezier2, mapCurve2, sample2, type NurbsCurve2Data } from '../lib/nurbs/curve2d';
import type { OutlineSegment } from '../lib/font/outline';
import { curveDomain } from '../lib/nurbs/evaluate';
import { integrateCurve } from '../lib/nurbs/integrate';
import type { NurbsCurveData } from '../lib/nurbs/types';

export type PlaneSegment =
  | { readonly kind: 'line'; readonly from: Vec2; readonly to: Vec2 }
  | { readonly kind: 'nurbs'; readonly curve: NurbsCurve2Data };

export const segmentStart = (segment: PlaneSegment): Vec2 => (segment.kind === 'line' ? segment.from : (segment.curve.poles[0] as Vec2));

export const segmentEnd = (segment: PlaneSegment): Vec2 =>
  segment.kind === 'line' ? segment.to : (segment.curve.poles[segment.curve.poles.length - 1] as Vec2);

/** Circumcircle arc through three points as a rational quadratic NURBS (counter-clockwise or clockwise as the points run); null when collinear. */
function arcThrough(start: Vec2, through: Vec2, end: Vec2): NurbsCurve2Data | null {
  const [ax, ay] = start;
  const [bx, by] = through;
  const [cx, cy] = end;
  const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
  if (Math.abs(d) < 1e-14) return null;
  const centerX = ((ax * ax + ay * ay) * (by - cy) + (bx * bx + by * by) * (cy - ay) + (cx * cx + cy * cy) * (ay - by)) / d;
  const centerY = ((ax * ax + ay * ay) * (cx - bx) + (bx * bx + by * by) * (ax - cx) + (cx * cx + cy * cy) * (bx - ax)) / d;
  const radius = Math.hypot(ax - centerX, ay - centerY);
  const counterClockwise = (bx - ax) * (cy - by) - (by - ay) * (cx - bx) > 0;
  const a0 = Math.atan2(ay - centerY, ax - centerX);
  const a1 = Math.atan2(cy - centerY, cx - centerX);
  const turn = 2 * Math.PI;
  const sweepCcw = (((a1 - a0) % turn) + turn) % turn;
  const sweep = counterClockwise ? sweepCcw : (turn - sweepCcw) % turn;
  const full = sweep === 0 ? turn : sweep;
  if (counterClockwise) return arc2([centerX, centerY], radius, a0, full);
  const reversed = arc2([centerX, centerY], radius, a1, full);
  return { ...reversed, poles: [...reversed.poles].reverse(), weights: [...(reversed.weights ?? [])].reverse() };
}

/** Ellipse quarter [start, centre, end] as a rational quadratic NURBS (affine image of the unit-circle quarter). */
function ellipseQuarter2(start: Vec2, center: Vec2, end: Vec2): NurbsCurve2Data {
  return {
    degree: 2,
    poles: [start, [start[0] + end[0] - center[0], start[1] + end[1] - center[1]], end],
    weights: [1, Math.SQRT1_2, 1],
    knots: [0, 1],
    multiplicities: [3, 3],
  };
}

/** A sketch curve piece (line, three-point arc, cubic Bezier) as a planar segment. @failure collinear arc points -> a line */
export function segmentOfCurve(segment: CurveSegment<Vec2>): PlaneSegment {
  if (segment.type === 'line') return { kind: 'line', from: segment.points[0], to: segment.points[1] };
  if (segment.type === 'bezier') return { kind: 'nurbs', curve: bezier2(segment.points) };
  if (segment.type === 'ellipse') return { kind: 'nurbs', curve: ellipseQuarter2(...segment.points) };
  const arc = arcThrough(...segment.points);
  return arc === null ? { kind: 'line', from: segment.points[0], to: segment.points[2] } : { kind: 'nurbs', curve: arc };
}

/** A font outline segment (line, quadratic or cubic) as a planar segment. */
export function segmentOfOutline(segment: OutlineSegment): PlaneSegment {
  return segment.kind === 'line'
    ? { kind: 'line', from: segment.from, to: segment.to }
    : segment.kind === 'quad'
      ? { kind: 'nurbs', curve: bezier2([segment.from, segment.control, segment.to]) }
      : { kind: 'nurbs', curve: bezier2([segment.from, segment.control1, segment.control2, segment.to]) };
}

/** The segment with every point mapped by the affine map `f`. */
export function mapSegment2(segment: PlaneSegment, f: (point: Vec2) => Vec2): PlaneSegment {
  return segment.kind === 'line'
    ? { kind: 'line', from: f(segment.from), to: f(segment.to) }
    : { kind: 'nurbs', curve: mapCurve2(segment.curve, f) };
}

/** `count` (>= 2) points along the segment, both ends included. */
export function sampleSegment(segment: PlaneSegment, count: number): Vec2[] {
  if (segment.kind === 'nurbs') return sample2(segment.curve, count);
  return Array.from({ length: count }, (_, k): Vec2 => {
    const t = k / (count - 1);
    return [segment.from[0] + t * (segment.to[0] - segment.from[0]), segment.from[1] + t * (segment.to[1] - segment.from[1])];
  });
}

const lifted = (curve: NurbsCurve2Data): NurbsCurveData => ({ ...curve, poles: curve.poles.map(([x, y]): Vec3 => [x, y, 0]) });

/** Arc length of the segment: exact for a line, composite Gauss-Legendre of |C'| over every knot span for a curve. */
export function segmentLength(segment: PlaneSegment): number {
  if (segment.kind === 'line') return Math.hypot(segment.to[0] - segment.from[0], segment.to[1] - segment.from[1]);
  const curve = lifted(segment.curve);
  const [first, last] = curveDomain(curve);
  return integrateCurve(curve, first, last, (_point, derivative) => Math.hypot(derivative[0], derivative[1]));
}

/** Area term of the segment in Green's theorem, 1/2 of the integral of (x dy - y dx): the signed area of a closed loop is the sum over its segments. */
export function segmentArea(segment: PlaneSegment): number {
  if (segment.kind === 'line') return (segment.from[0] * segment.to[1] - segment.to[0] * segment.from[1]) / 2;
  const curve = lifted(segment.curve);
  const [first, last] = curveDomain(curve);
  return integrateCurve(curve, first, last, (point, derivative) => (point[0] * derivative[1] - point[1] * derivative[0]) / 2);
}
