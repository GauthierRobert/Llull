/**
 * Planar NURBS curves (03 WRP): pcurves in a surface's (u, v) plane and sketch outlines in chart coordinates. Same clamped, compressed-knot layout as
 * the 3D `NurbsCurveData`; evaluation lifts to z = 0 and reuses the 3D code. Affine maps keep a NURBS exact (poles move, weights stay).
 */

import type { Vec2, Vec3 } from '../../model/vectors';
import { curveDerivatives } from './evaluate';
import type { NurbsCurveData } from './types';

export interface NurbsCurve2Data {
  readonly degree: number;
  readonly poles: ReadonlyArray<Vec2>;
  readonly weights?: ReadonlyArray<number>;
  readonly knots: ReadonlyArray<number>;
  readonly multiplicities: ReadonlyArray<number>;
}

const lift = (curve: NurbsCurve2Data): NurbsCurveData => ({ ...curve, poles: curve.poles.map(([x, y]): Vec3 => [x, y, 0]) });

/** The Bezier curve of degree `points.length - 1` through the control polygon (line, quadratic, cubic ...). */
export function bezier2(points: ReadonlyArray<Vec2>): NurbsCurve2Data {
  const degree = points.length - 1;
  return { degree, poles: points, knots: [0, 1], multiplicities: [degree + 1, degree + 1] };
}

/**
 * Circular arc of `sweep` radians (> 0, <= 2 pi) from `startAngle` about `center` as a rational quadratic NURBS (Piegl & Tiller §7.3: up to four
 * pieces of at most 90 degrees, middle weight cos(half piece)). Counter-clockwise.
 */
export function arc2(center: Vec2, radius: number, startAngle: number, sweep: number): NurbsCurve2Data {
  const pieces = Math.max(1, Math.ceil(sweep / (Math.PI / 2) - 1e-12));
  const piece = sweep / pieces;
  const half = Math.cos(piece / 2);
  const at = (angle: number, scale: number): Vec2 => [
    center[0] + scale * radius * Math.cos(angle),
    center[1] + scale * radius * Math.sin(angle),
  ];
  const poles: Vec2[] = [at(startAngle, 1)];
  const weights: number[] = [1];
  for (let k = 0; k < pieces; k++) {
    const from = startAngle + k * piece;
    poles.push(at(from + piece / 2, 1 / half), at(from + piece, 1));
    weights.push(half, 1);
  }
  const knots: number[] = [0];
  const multiplicities: number[] = [3];
  for (let k = 1; k < pieces; k++) {
    knots.push(k / pieces);
    multiplicities.push(2);
  }
  knots.push(1);
  multiplicities.push(3);
  return { degree: 2, poles, weights, knots, multiplicities };
}

/** `curve` with every pole mapped by `map`; exact for an affine map. */
export const mapCurve2 = (curve: NurbsCurve2Data, map: (point: Vec2) => Vec2): NurbsCurve2Data => ({
  ...curve,
  poles: curve.poles.map(map),
});

/** Point at parameter `t`. */
export function pointAt2(curve: NurbsCurve2Data, t: number): Vec2 {
  const point = curveDerivatives(lift(curve), t, 0)[0] as Vec3;
  return [point[0], point[1]];
}

/** `count` (>= 2) points evenly spaced in parameter, both ends included. */
export function sample2(curve: NurbsCurve2Data, count: number): Vec2[] {
  const from = curve.knots[0] as number;
  const to = curve.knots[curve.knots.length - 1] as number;
  return Array.from({ length: count }, (_, k) => pointAt2(curve, k === count - 1 ? to : from + ((to - from) * k) / (count - 1)));
}
