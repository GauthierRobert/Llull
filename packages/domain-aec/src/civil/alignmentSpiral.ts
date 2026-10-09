/**
 * Clothoid (Euler spiral) transition geometry: exact Fresnel-series coordinates, the shift / tangent
 * length of a symmetric spiral-circular curve-spiral, and spiral element evaluation.
 * A spiral of length L ending at radius R has constant A^2 = R L, curvature l / A^2 at distance l and
 * heading change theta = l^2 / (2 A^2) from the tangent end.
 * @layer domain-aec/civil
 * @pure
 */

import type { Vec2 } from '@core/model/types';

export interface SpiralElement {
  readonly kind: 'spiral';
  readonly start: Vec2;
  readonly end: Vec2;
  /** Radius at the start (Infinity at the tangent end). */
  readonly radiusStart: number;
  /** Radius at the end (Infinity at the tangent end). */
  readonly radiusEnd: number;
  readonly length: number;
  readonly startStation: number;
  readonly rotation: 'cw' | 'ccw';
  /** The point of intersection of the two tangents of the whole curve. */
  readonly pi: Vec2;
  /** Point of the spiral on the tangent (TS for an entry spiral, ST for an exit spiral). */
  readonly tangentPoint: Vec2;
  /** Travel direction at `tangentPoint` (radians). */
  readonly tangentHeading: number;
}

export interface SpiralCurve {
  /** Length of each transition spiral. */
  readonly length: number;
  /** Spiral angle at the circular curve, Ls / (2 R). */
  readonly theta: number;
  /** Clothoid coordinates of the SC point in the tangent frame. */
  readonly xs: number;
  readonly ys: number;
  /** Offset of the circle from the tangent. */
  readonly shift: number;
  /** Tangent distance from TS to the circle's foot of perpendicular. */
  readonly k: number;
  /** Total tangent length TS - PI. */
  readonly tangent: number;
  /** Central angle of the circular part, deflection - 2 theta. */
  readonly arcAngle: number;
}

const SERIES_TERMS = 16;
const ANGLE_SLACK = 1e-9;

/** Clothoid point at distance `along` from the tangent end of a spiral of length `length` and end radius `radius`. */
export function clothoidLocal(along: number, radius: number, length: number): Vec2 {
  const theta = (along * along) / (2 * radius * length);
  let x = 0;
  let y = 0;
  let sign = 1;
  let power = 1;
  let factorial = 1;
  for (let n = 0; n < SERIES_TERMS; n++) {
    x += (sign * power) / ((4 * n + 1) * factorial);
    const odd = power * theta;
    y += (sign * odd) / ((4 * n + 3) * factorial * (2 * n + 1));
    power = odd * theta;
    factorial *= (2 * n + 1) * (2 * n + 2);
    sign = -sign;
  }
  return [along * x, along * y];
}

/** Spiral-curve constants for `radius`, spiral `length` and total `deflection`; null when deflection < 2 theta. */
export function spiralCurve(
  radius: number,
  length: number,
  deflection: number,
): SpiralCurve | null {
  const theta = length / (2 * radius);
  if (deflection < 2 * theta - ANGLE_SLACK) return null;
  const [xs, ys] = clothoidLocal(length, radius, length);
  const shift = ys - radius * (1 - Math.cos(theta));
  const k = xs - radius * Math.sin(theta);
  return {
    length,
    theta,
    xs,
    ys,
    shift,
    k,
    tangent: (radius + shift) * Math.tan(deflection / 2) + k,
    arcAngle: Math.max(deflection - 2 * theta, 0),
  };
}

function finiteRadius(element: SpiralElement): number {
  return Number.isFinite(element.radiusEnd) ? element.radiusEnd : element.radiusStart;
}

/** Heading change of the whole spiral, L / (2 R). */
export function spiralSweep(element: SpiralElement): number {
  return element.length / (2 * finiteRadius(element));
}

/** Point and travel direction on a spiral at `along` (0..length) from its start. */
export function spiralPointAt(
  element: SpiralElement,
  along: number,
): { point: Vec2; direction: number } {
  const radius = finiteRadius(element);
  const turn = element.rotation === 'ccw' ? 1 : -1;
  const entry = element.radiusStart === Infinity;
  const distance = entry ? along : element.length - along;
  const [x, y] = clothoidLocal(distance, radius, element.length);
  const theta = (distance * distance) / (2 * radius * element.length);
  const cos = Math.cos(element.tangentHeading);
  const sin = Math.sin(element.tangentHeading);
  const local: Vec2 = entry ? [x, turn * y] : [-x, turn * y];
  return {
    point: [
      element.tangentPoint[0] + local[0] * cos - local[1] * sin,
      element.tangentPoint[1] + local[0] * sin + local[1] * cos,
    ],
    direction: element.tangentHeading + (entry ? turn * theta : -turn * theta),
  };
}

/** Station on the spiral nearest `xy` (coarse scan, then ternary refinement). */
export function nearestAlongSpiral(element: SpiralElement, xy: Vec2): number {
  const distance = (along: number): number => {
    const point = spiralPointAt(element, along).point;
    return Math.hypot(xy[0] - point[0], xy[1] - point[1]);
  };
  const samples = 32;
  let best = 0;
  for (let i = 1; i <= samples; i++) {
    if (distance((element.length * i) / samples) < distance((element.length * best) / samples)) {
      best = i;
    }
  }
  let low = (element.length * Math.max(best - 1, 0)) / samples;
  let high = (element.length * Math.min(best + 1, samples)) / samples;
  for (let k = 0; k < 40; k++) {
    const a = low + (high - low) / 3;
    const b = high - (high - low) / 3;
    if (distance(a) < distance(b)) high = b;
    else low = a;
  }
  return element.startStation + (low + high) / 2;
}
