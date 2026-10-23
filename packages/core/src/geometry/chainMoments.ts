/**
 * Exact Green's-theorem moments of a closed 2D curve chain: area and ∬x dA, the two numbers Pappus needs for a revolution.
 * Lines integrate exactly, arcs / ellipse quarters / cubic Béziers by 32-point Gauss-Legendre (exact for Béziers, machine precision for trig).
 */

import type { CurveSegment } from '../model/curve';
import type { Vec2 } from '../model/types';
import { arcGeometry, segmentPoint } from './curveSegments';
import { ellipseVelocity, integrateUnit } from './ellipseSegment';

/** dP/dt of a segment on t in [0, 1] (xy only). */
function velocity(segment: CurveSegment<Vec2>, t: number): Vec2 {
  switch (segment.type) {
    case 'line': {
      const [a, b] = segment.points;
      return [b[0] - a[0], b[1] - a[1]];
    }
    case 'ellipse': {
      const d = ellipseVelocity(segment.points, t);
      return [d[0], d[1]];
    }
    case 'arc': {
      const [a, through, b] = segment.points;
      const g = arcGeometry(a, through, b);
      if (g === null) return [b[0] - a[0], b[1] - a[1]];
      const angle = g.sweep * t;
      const k = g.radius * g.sweep;
      return [k * (-Math.sin(angle) * g.u[0] + Math.cos(angle) * g.v[0]), k * (-Math.sin(angle) * g.u[1] + Math.cos(angle) * g.v[1])];
    }
    case 'bezier': {
      const [p0, p1, p2, p3] = segment.points;
      const s = 1 - t;
      const d = (k: 0 | 1): number => 3 * (s * s * (p1[k] - p0[k]) + 2 * s * t * (p2[k] - p1[k]) + t * t * (p3[k] - p2[k]));
      return [d(0), d(1)];
    }
  }
}

/**
 * Signed area ½∮(x dy − y dx) and first moment ∬x dA = ½∮x² dy of a closed chain (counter-clockwise positive).
 * @invariant the chain is closed; an open chain gives the moments of the region closed by the straight chord only if the caller adds it
 */
export function chainMoments(curves: ReadonlyArray<CurveSegment<Vec2>>): { area: number; momentX: number } {
  let area = 0;
  let momentX = 0;
  for (const segment of curves) {
    area += integrateUnit((t) => {
      const [x, y] = segmentPoint(segment, t);
      const [dx, dy] = velocity(segment, t);
      return 0.5 * (x * dy - y * dx);
    });
    momentX += integrateUnit((t) => {
      const [x] = segmentPoint(segment, t);
      return 0.5 * x * x * velocity(segment, t)[1];
    });
  }
  return { area, momentX };
}
