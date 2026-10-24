/**
 * Closed outlines of line, quadratic-Bezier (TrueType) and cubic-Bezier (CFF) segments: contour -> loop, Green area (closed form for quadratics, exact Gauss quadrature of
 * the degree-5 integrand for cubics), arc length, bounding box, flattening and affine placement. Coordinates are plain numbers in whatever unit the caller keeps (font units until `placeLoop`).
 */

import type { Vec2 } from '../../model/vectors';
import type { RawContour } from './glyf';

export type OutlineSegment =
  | { readonly kind: 'line'; readonly from: Vec2; readonly to: Vec2 }
  | { readonly kind: 'quad'; readonly from: Vec2; readonly control: Vec2; readonly to: Vec2 }
  | { readonly kind: 'cubic'; readonly from: Vec2; readonly control1: Vec2; readonly control2: Vec2; readonly to: Vec2 };

export type OutlineLoop = readonly OutlineSegment[];

const mid = (a: Vec2, b: Vec2): Vec2 => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];

/** The closed loop of a TrueType contour: implied on-curve midpoints between consecutive off-curve points; an all-off contour starts at the midpoint of its last and first points. */
export function contourLoop(contour: RawContour): OutlineLoop {
  if (contour.length === 0) return [];
  const points = contour.map((point) => ({ at: [point.x, point.y] as Vec2, on: point.on }));
  let start = points.findIndex((point) => point.on);
  if (start < 0) {
    const first = points[0] as { at: Vec2 };
    const last = points[points.length - 1] as { at: Vec2 };
    points.unshift({ at: mid(last.at, first.at), on: true });
    start = 0;
  }
  const ring = [...points.slice(start), ...points.slice(0, start)];
  const segments: OutlineSegment[] = [];
  let current = (ring[0] as { at: Vec2 }).at;
  let control: Vec2 | null = null;
  for (let k = 1; k <= ring.length; k++) {
    const point = ring[k % ring.length] as { at: Vec2; on: boolean };
    if (point.on) {
      segments.push(
        control === null ? { kind: 'line', from: current, to: point.at } : { kind: 'quad', from: current, control, to: point.at },
      );
      current = point.at;
      control = null;
    } else if (control === null) {
      control = point.at;
    } else {
      const implied = mid(control, point.at);
      segments.push({ kind: 'quad', from: current, control, to: implied });
      current = implied;
      control = point.at;
    }
  }
  return segments;
}

const cross = (p: Vec2, q: Vec2): number => p[0] * q[1] - q[0] * p[1];

/** 4-point Gauss-Legendre rule on [0, 1]: exact for polynomials up to degree 7 (the cubic area integrand is degree 5). */
const GAUSS4: ReadonlyArray<readonly [number, number]> = [
  [0.0694318442029737, 0.1739274225687269],
  [0.3300094782075719, 0.3260725774312731],
  [0.6699905217924281, 0.3260725774312731],
  [0.9305681557970263, 0.1739274225687269],
];

type CubicSegment = { readonly from: Vec2; readonly control1: Vec2; readonly control2: Vec2; readonly to: Vec2 };

const cubicPoint = (s: CubicSegment, t: number, axis: 0 | 1): number => {
  const u = 1 - t;
  return u * u * u * s.from[axis] + 3 * u * u * t * s.control1[axis] + 3 * u * t * t * s.control2[axis] + t * t * t * s.to[axis];
};

const cubicSlope = (s: CubicSegment, t: number, axis: 0 | 1): number => {
  const u = 1 - t;
  return (
    3 *
    (u * u * (s.control1[axis] - s.from[axis]) +
      2 * u * t * (s.control2[axis] - s.control1[axis]) +
      t * t * (s.to[axis] - s.control2[axis]))
  );
};

/** Signed area of the loop (counter-clockwise > 0): a quadratic segment adds (2/3)(P0 x C + C x P1) / 2 + (1/3)(P0 x P1) / 2 (exact); a cubic is integrated exactly by Gauss quadrature. */
export function loopArea(loop: OutlineLoop): number {
  let twice = 0;
  for (const segment of loop) {
    if (segment.kind === 'line') twice += cross(segment.from, segment.to);
    else if (segment.kind === 'quad')
      twice +=
        (2 / 3) * (cross(segment.from, segment.control) + cross(segment.control, segment.to)) + (1 / 3) * cross(segment.from, segment.to);
    else
      for (const [t, weight] of GAUSS4)
        twice += weight * (cubicPoint(segment, t, 0) * cubicSlope(segment, t, 1) - cubicPoint(segment, t, 1) * cubicSlope(segment, t, 0));
  }
  return twice / 2;
}

/** Exact arc length of a quadratic Bezier: 2 * integral over [0, 1] of |B + tA|, B = C - P0, A = P1 - 2C + P0. */
function quadLength(from: Vec2, control: Vec2, to: Vec2): number {
  const ax = to[0] - 2 * control[0] + from[0];
  const ay = to[1] - 2 * control[1] + from[1];
  const bx = control[0] - from[0];
  const by = control[1] - from[1];
  const a = ax * ax + ay * ay;
  const b = ax * bx + ay * by;
  const c = bx * bx + by * by;
  if (a < 1e-18 * (c + 1)) return 2 * Math.sqrt(c);
  const at = (t: number): number => {
    const root = Math.sqrt(Math.max(0, a * t * t + 2 * b * t + c));
    const linear = ((a * t + b) * root) / (2 * a);
    const gap = a * c - b * b;
    if (gap <= 1e-12 * a * c) return linear;
    return linear + (gap / (2 * a * Math.sqrt(a))) * Math.log(a * t + b + Math.sqrt(a) * root);
  };
  return 2 * (at(1) - at(0));
}

/** Arc length of a cubic: 16 pieces of the 4-point Gauss rule on the speed (converged to better than 1e-12 for glyph-sized curves). */
function cubicLength(segment: CubicSegment): number {
  const pieces = 16;
  let total = 0;
  for (let piece = 0; piece < pieces; piece++)
    for (const [t, weight] of GAUSS4) {
      const at = (piece + t) / pieces;
      total += (weight / pieces) * Math.hypot(cubicSlope(segment, at, 0), cubicSlope(segment, at, 1));
    }
  return total;
}

/** Arc length of the loop (closed form for lines and quadratics, quadrature for cubics). */
export function loopLength(loop: OutlineLoop): number {
  let total = 0;
  for (const segment of loop)
    total +=
      segment.kind === 'line'
        ? Math.hypot(segment.to[0] - segment.from[0], segment.to[1] - segment.from[1])
        : segment.kind === 'quad'
          ? quadLength(segment.from, segment.control, segment.to)
          : cubicLength(segment);
  return total;
}

/** Polyline of the loop: `perQuad` points on every curve (quadratic or cubic), the segment ends of lines. Closed implicitly (the first point is not repeated). */
export function flattenLoop(loop: OutlineLoop, perQuad: number): Vec2[] {
  const points: Vec2[] = [];
  for (const segment of loop) {
    points.push(segment.from);
    if (segment.kind === 'quad')
      for (let k = 1; k < perQuad; k++) {
        const t = k / perQuad;
        const s = 1 - t;
        points.push([
          s * s * segment.from[0] + 2 * s * t * segment.control[0] + t * t * segment.to[0],
          s * s * segment.from[1] + 2 * s * t * segment.control[1] + t * t * segment.to[1],
        ]);
      }
    else if (segment.kind === 'cubic')
      for (let k = 1; k < perQuad; k++) points.push([cubicPoint(segment, k / perQuad, 0), cubicPoint(segment, k / perQuad, 1)]);
  }
  return points;
}

export interface OutlineBox {
  readonly min: Vec2;
  readonly max: Vec2;
}

/** Axis-aligned box of the segment end points and curve extrema. */
export function loopBox(loop: OutlineLoop): OutlineBox | null {
  const points: Vec2[] = [];
  for (const segment of loop) {
    points.push(segment.from, segment.to);
    if (segment.kind === 'quad')
      for (const axis of [0, 1] as const) {
        const denominator = segment.from[axis] - 2 * segment.control[axis] + segment.to[axis];
        const t = denominator === 0 ? -1 : (segment.from[axis] - segment.control[axis]) / denominator;
        if (t > 0 && t < 1) {
          const s = 1 - t;
          points.push([
            s * s * segment.from[0] + 2 * s * t * segment.control[0] + t * t * segment.to[0],
            s * s * segment.from[1] + 2 * s * t * segment.control[1] + t * t * segment.to[1],
          ]);
        }
      }
    else if (segment.kind === 'cubic')
      for (const axis of [0, 1] as const) {
        // the slope over 3 is a t^2 + b t + c in the differences of the control points
        const d0 = segment.control1[axis] - segment.from[axis];
        const d1 = segment.control2[axis] - segment.control1[axis];
        const d2 = segment.to[axis] - segment.control2[axis];
        const [a, b, c] = [d0 - 2 * d1 + d2, 2 * (d1 - d0), d0];
        const roots: number[] = [];
        if (Math.abs(a) < 1e-12) {
          if (b !== 0) roots.push(-c / b);
        } else {
          const disc = b * b - 4 * a * c;
          if (disc >= 0) roots.push((-b + Math.sqrt(disc)) / (2 * a), (-b - Math.sqrt(disc)) / (2 * a));
        }
        for (const t of roots) if (t > 0 && t < 1) points.push([cubicPoint(segment, t, 0), cubicPoint(segment, t, 1)]);
      }
  }
  if (points.length === 0) return null;
  return {
    min: [Math.min(...points.map((p) => p[0])), Math.min(...points.map((p) => p[1]))],
    max: [Math.max(...points.map((p) => p[0])), Math.max(...points.map((p) => p[1]))],
  };
}

/** The loop with every point mapped by `map` (an affine map keeps quadratics and cubics exact). */
export function mapLoop(loop: OutlineLoop, map: (point: Vec2) => Vec2): OutlineLoop {
  return loop.map((segment) =>
    segment.kind === 'line'
      ? { kind: 'line', from: map(segment.from), to: map(segment.to) }
      : segment.kind === 'quad'
        ? { kind: 'quad', from: map(segment.from), control: map(segment.control), to: map(segment.to) }
        : { kind: 'cubic', from: map(segment.from), control1: map(segment.control1), control2: map(segment.control2), to: map(segment.to) },
  );
}
