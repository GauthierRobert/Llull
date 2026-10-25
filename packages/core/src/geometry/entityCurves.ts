/**
 * Exact curves of 2D sketch entities in their local plane (line, arc, circle, ellipse, rectangle, polyline, spline), shared by the sketch-to-solid commands and by
 * the implicit plugin's graph lattice. Pure, no document access.
 */

import type { CurveSegment } from '../model/curve';
import type { Entity, Vec2 } from '../model/types';
import { positiveSweep } from '../lib/angle';
import { polar } from '../lib/arc';
import { JOINT_TOLERANCE, catmullRomBeziers } from './curveSegments';

/** Cubic Bézier handle length of a quarter ellipse (max radial error ≈ 0.03 %). */
const QUARTER_KAPPA = 0.5522847498;

const line = (a: Vec2, b: Vec2): CurveSegment<Vec2> => ({ type: 'line', points: [a, b] });

function ellipseCurves(center: Vec2, rx: number, ry: number): CurveSegment<Vec2>[] {
  const at = (x: number, y: number): Vec2 => [center[0] + x, center[1] + y];
  const quarters: Array<[number, number, number, number]> = [
    [1, 0, 0, 1],
    [0, 1, -1, 0],
    [-1, 0, 0, -1],
    [0, -1, 1, 0],
  ];
  return quarters.map(([ax, ay, bx, by]) => ({
    type: 'bezier',
    points: [
      at(ax * rx, ay * ry),
      at(ax * rx + bx * rx * QUARTER_KAPPA, ay * ry + by * ry * QUARTER_KAPPA),
      at(bx * rx + ax * rx * QUARTER_KAPPA, by * ry + ay * ry * QUARTER_KAPPA),
      at(bx * rx, by * ry),
    ],
  }));
}

/**
 * Exact curves of one 2D entity in its local plane, and whether they already close.
 * @failure kinds without a curve (point, text, dimension, solids) -> null
 */
export function entityCurves(entity: Entity): { curves: CurveSegment<Vec2>[]; closed: boolean } | null {
  switch (entity.kind) {
    case 'line':
      return { curves: [line(entity.start, entity.end)], closed: false };
    case 'arc': {
      const sweep = positiveSweep(entity.endAngle - entity.startAngle);
      const { center, radius, startAngle } = entity;
      const at = (t: number): Vec2 => polar(center, radius, startAngle + sweep * t);
      return { curves: [{ type: 'arc', points: [at(0), at(0.5), at(1)] }], closed: false };
    }
    case 'circle': {
      const { center, radius } = entity;
      const p = (quarter: number): Vec2 => polar(center, radius, (quarter * Math.PI) / 2);
      return {
        curves: [
          { type: 'arc', points: [p(0), p(1), p(2)] },
          { type: 'arc', points: [p(2), p(3), p(0)] },
        ],
        closed: true,
      };
    }
    case 'ellipse':
      return { curves: ellipseCurves(entity.center, entity.radiusX, entity.radiusY), closed: true };
    case 'rectangle': {
      const corners: Vec2[] = [
        [0, 0],
        [entity.width, 0],
        [entity.width, entity.height],
        [0, entity.height],
      ];
      return { curves: corners.map((c, i) => line(c, corners[(i + 1) % 4] as Vec2)), closed: true };
    }
    case 'polyline': {
      const pts = entity.points;
      const count = entity.closed ? pts.length : pts.length - 1;
      const curves = Array.from({ length: Math.max(0, count) }, (_, i) => line(pts[i] as Vec2, pts[(i + 1) % pts.length] as Vec2)).filter(
        ({ points: [a, b] }) => Math.hypot(b[0] - a[0], b[1] - a[1]) > JOINT_TOLERANCE,
      );
      return { curves, closed: entity.closed };
    }
    case 'spline':
      return entity.points.length < 2
        ? { curves: [], closed: entity.closed }
        : { curves: catmullRomBeziers(entity.points, entity.closed), closed: entity.closed };
    default:
      return null;
  }
}
