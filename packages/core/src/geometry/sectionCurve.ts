/** Exact NURBS curves of the 2D section shapes a loft accepts (circle, ellipse, polygon, a closed chain of lines / arcs / Béziers), in section coordinates. */

import type { CurveSegment } from '../model/curve';
import type { Vec2, Vec3 } from '../model/types';
import { elevateDegree } from '../lib/nurbs/edit';
import type { NurbsCurveData } from '../lib/nurbs/types';
import { constantEdges, type SectionEdge } from './sweepEval/sectionEdges';

const QUARTER_WEIGHT = Math.SQRT1_2;

/** Closed rational quadratic ellipse of half-axes `rx` (along x) and `ry` (along y) centred on the origin, starting at (rx, 0), counter-clockwise (9 poles). */
export function ellipseCurve(rx: number, ry: number): NurbsCurveData {
  const corners: Vec2[] = [
    [rx, 0],
    [rx, ry],
    [0, ry],
    [-rx, ry],
    [-rx, 0],
    [-rx, -ry],
    [0, -ry],
    [rx, -ry],
    [rx, 0],
  ];
  return {
    degree: 2,
    poles: corners.map(([x, y]): Vec3 => [x, y, 0]),
    weights: corners.map((_, i) => (i % 2 === 0 ? 1 : QUARTER_WEIGHT)),
    knots: [0, 0.25, 0.5, 0.75, 1],
    multiplicities: [3, 2, 2, 2, 3],
  };
}

/** Closed degree-1 curve through the polygon's points (the first point is repeated at the end). */
export function polygonCurve(points: ReadonlyArray<Vec2>): NurbsCurveData {
  const poles = [...points, points[0] as Vec2].map(([x, y]): Vec3 => [x, y, 0]);
  const knots = poles.map((_, i) => i / (poles.length - 1));
  return { degree: 1, poles, knots, multiplicities: knots.map((_, i) => (i === 0 || i === knots.length - 1 ? 2 : 1)) };
}

/** One section edge as a curve of its own (knots 0..1). */
const edgeCurve = ({ degree, poles, weights }: SectionEdge): NurbsCurveData => ({
  degree,
  poles: poles.map(([x, y]): Vec3 => [x, y, 0]),
  ...(weights === undefined ? {} : { weights }),
  knots: [0, 1],
  multiplicities: [degree + 1, degree + 1],
});

/**
 * One curve through a closed chain of lines, arcs and cubic Béziers: every piece raised to the highest degree and joined end to end (C0).
 * @failure a degenerate arc, or a failing degree elevation -> null
 */
export function chainCurve(segments: ReadonlyArray<CurveSegment<Vec2>>): NurbsCurveData | null {
  const edges = constantEdges({ shape: 'profile', profile: [], curves: segments });
  if (edges === null || edges.length === 0) return null;
  const degree = Math.max(...edges.map((edge) => edge.degree));
  const pieces: NurbsCurveData[] = [];
  for (const edge of edges) {
    const raised = edge.degree === degree ? edgeCurve(edge) : elevateDegree(edgeCurve(edge), degree - edge.degree);
    if (typeof raised === 'string') return null;
    pieces.push(raised);
  }
  const rational = pieces.some((piece) => piece.weights !== undefined);
  const poles: Vec3[] = [];
  const weights: number[] = [];
  pieces.forEach((piece, i) => {
    piece.poles.forEach((pole, j) => {
      if (i > 0 && j === 0) return;
      poles.push(pole);
      weights.push(piece.weights?.[j] ?? 1);
    });
  });
  const knots = pieces.map((_, i) => i / pieces.length).concat(1);
  return {
    degree,
    poles,
    ...(rational ? { weights } : {}),
    knots,
    multiplicities: knots.map((_, i) => (i === 0 || i === knots.length - 1 ? degree + 1 : degree)),
  };
}
