/**
 * Exact curvature vector dT/ds of a sweep path at arc-length fractions: arcs in closed form (centre direction over R^2), cubic Béziers and ellipse
 * quarters from their analytic first and second derivatives ((d1 x d2) x d1 / |d1|^4), the exact helix of an `add_helix` path from its own derivatives.
 * @invariant no sampling or finite differences of the path: the only numeric step is the arc-length inversion shared with the frames (`locateOnPath`)
 */

import type { CurveSegment } from '../../model/curve';
import type { Vec3 } from '../../model/types';
import type { HelixDefinition } from '../../lib/helix/types';
import { helixBendAtFractions } from '../../lib/helix/helix';
import { add3, cross3, dot3, scale3, sub3 } from '../../lib/vec3';
import { arcGeometry, segmentPoint } from '../curveSegments';
import { locateOnPath } from './frames';

const ZERO: Vec3 = [0, 0, 0];

/** dT/ds from the first and second derivatives with respect to any parameter (zero at a stationary point). */
function bendFromDerivatives(d1: Vec3, d2: Vec3): Vec3 {
  const speedSquared = dot3(d1, d1);
  return speedSquared > 1e-24 ? scale3(cross3(cross3(d1, d2), d1), 1 / (speedSquared * speedSquared)) : ZERO;
}

function segmentBend(segment: CurveSegment<Vec3>, u: number): Vec3 {
  if (segment.type === 'line') return ZERO;
  if (segment.type === 'arc') {
    const geometry = arcGeometry(segment.points[0], segment.points[1], segment.points[2]);
    if (geometry === null) return ZERO;
    return scale3(sub3(geometry.center, segmentPoint(segment, u)), 1 / geometry.radius ** 2);
  }
  if (segment.type === 'ellipse') {
    const [start, centre, end] = segment.points.map((p): Vec3 => [p[0], p[1], p[2] ?? 0]) as [Vec3, Vec3, Vec3];
    const [a, b] = [sub3(start, centre), sub3(end, centre)];
    const angle = (Math.PI / 2) * u;
    const first = scale3(add3(scale3(a, -Math.sin(angle)), scale3(b, Math.cos(angle))), Math.PI / 2);
    const second = scale3(add3(scale3(a, Math.cos(angle)), scale3(b, Math.sin(angle))), -((Math.PI / 2) ** 2));
    return bendFromDerivatives(first, second);
  }
  const [p0, p1, p2, p3] = segment.points as [Vec3, Vec3, Vec3, Vec3];
  const s = 1 - u;
  const first = scale3(add3(add3(scale3(sub3(p1, p0), s * s), scale3(sub3(p2, p1), 2 * s * u)), scale3(sub3(p3, p2), u * u)), 3);
  const second = scale3(add3(scale3(add3(sub3(p2, scale3(p1, 2)), p0), s), scale3(add3(sub3(p3, scale3(p2, 2)), p1), u)), 6);
  return bendFromDerivatives(first, second);
}

/** Curvature vector dT/ds (toward the centre of curvature; length = 1 / radius of curvature) at each arc-length fraction of the path. */
export function pathBendAt(path: ReadonlyArray<CurveSegment<Vec3>>, fractions: readonly number[], helix?: HelixDefinition): Vec3[] {
  if (helix !== undefined) return helixBendAtFractions(helix, fractions);
  return locateOnPath(path, fractions).map(({ segment, u }) => segmentBend(path[segment] as CurveSegment<Vec3>, u));
}
