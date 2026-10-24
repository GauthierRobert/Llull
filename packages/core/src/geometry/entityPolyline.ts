/**
 * World-space polyline of a curve entity for graph lattices and similar consumers: straight pieces stay one segment, curved pieces (arcs, circles,
 * ellipses, splines, NURBS curves) are sampled so that no chord is longer than `chord`.
 * @invariant a polyline entity keeps its vertices; the result of an unchanged entity is identical
 */

import type { Entity, Vec3 } from '../model/types';
import { applyEulerXYZ } from '../lib/eulerRotation';
import { add3 } from '../lib/vec3';
import { chainLength, segmentPoint } from './curveSegments';
import { entityCurves } from './entityCurves';
import { curveDisplayPoints } from './nurbsCurve';
import { planeToWorld } from './workPlane';

/** Points `a`, ..., `b` along a polyline resampled so that each step is at most `chord` long (original vertices kept). */
function refine(points: readonly Vec3[], chord: number): Vec3[] {
  const out: Vec3[] = [];
  points.forEach((point, index) => {
    const previous = points[index - 1];
    if (previous !== undefined) {
      const length = Math.hypot(point[0] - previous[0], point[1] - previous[1], point[2] - previous[2]);
      const steps = Math.max(1, Math.ceil(length / chord - 1e-9));
      for (let s = 1; s < steps; s += 1) {
        const t = s / steps;
        out.push([
          previous[0] + (point[0] - previous[0]) * t,
          previous[1] + (point[1] - previous[1]) * t,
          previous[2] + (point[2] - previous[2]) * t,
        ]);
      }
    }
    out.push(point);
  });
  return out;
}

/**
 * Chain of world points of `entity`, or the reason it has none.
 * @failure not a line, polyline, arc, circle, ellipse, rectangle, spline or nurbs_curve -> message; chord <= 0 -> message
 */
export function entityWorldPolyline(entity: Entity, chord: number): Vec3[] | string {
  if (!(Number.isFinite(chord) && chord > 0)) return `chord must be > 0 (got ${chord})`;
  if (entity.kind === 'nurbs_curve') {
    const world = curveDisplayPoints(entity.curve).map((p) => add3(applyEulerXYZ(p, [0, 0, 0], entity.rotation), entity.position));
    return refine(world, chord);
  }
  const own = entityCurves(entity);
  if (own === null || own.curves.length === 0) return `entity '${entity.id}' (${entity.kind}) is not a curve with geometry`;
  const out: Vec3[] = [];
  own.curves.forEach((segment) => {
    const steps = segment.type === 'line' ? 1 : Math.max(2, Math.ceil(chainLength([segment]) / chord - 1e-9));
    for (let s = out.length === 0 ? 0 : 1; s <= steps; s += 1) {
      const local = segmentPoint(segment, s / steps);
      out.push(planeToWorld(entity.position, entity.rotation, [local[0], local[1]]));
    }
  });
  return out;
}
