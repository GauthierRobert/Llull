/** A 3D `nurbs_curve` as a chain of line / cubic Bézier segments (a sweep path): knots inserted to full multiplicity, poles grouped in fours. */

import type { CurveSegment } from '../model/curve';
import type { NurbsCurveEntity, Vec3 } from '../model/types';
import { applyEulerXYZ } from '../lib/eulerRotation';
import { distance3, add3 } from '../lib/vec3';
import { elevateDegree, insertKnot } from '../lib/nurbs/edit';
import type { NurbsCurveData } from '../lib/nurbs/types';
import { JOINT_TOLERANCE, mapSegment } from './curveSegments';

/** Bézier-form segments of a non-rational curve of degree 1..3, in the curve's own (local) coordinates. */
export function curveChain(curve: NurbsCurveData): CurveSegment<Vec3>[] | string {
  if (curve.weights !== undefined)
    return 'a rational curve cannot be a sweep path (use a non-rational curve, e.g. interpolate_curve or add_helix)';
  if (curve.degree > 3) return `a degree-${curve.degree} curve cannot be a sweep path (degree 1..3)`;
  if (curve.degree === 1) {
    const lines: CurveSegment<Vec3>[] = [];
    curve.poles.forEach((pole, i) => {
      const next = curve.poles[i + 1];
      if (next !== undefined && distance3(pole, next) > JOINT_TOLERANCE) lines.push({ type: 'line', points: [pole, next] });
    });
    return lines;
  }
  let cubic: NurbsCurveData | string = curve.degree === 2 ? elevateDegree(curve, 1) : curve;
  for (let k = 1; typeof cubic !== 'string' && k < cubic.knots.length - 1; k++) {
    const missing = 3 - (cubic.multiplicities[k] as number);
    if (missing > 0) cubic = insertKnot(cubic, cubic.knots[k] as number, missing);
  }
  if (typeof cubic === 'string') return cubic;
  const segments: CurveSegment<Vec3>[] = [];
  for (let i = 0; i + 3 < cubic.poles.length; i += 3)
    segments.push({
      type: 'bezier',
      points: [cubic.poles[i], cubic.poles[i + 1], cubic.poles[i + 2], cubic.poles[i + 3]] as [Vec3, Vec3, Vec3, Vec3],
    });
  return segments;
}

/**
 * World-space path of a `nurbs_curve` entity (placed by its position and rotation).
 * @failure rational curve, degree above 3, an edit failure -> message
 */
export function nurbsPath(entity: NurbsCurveEntity): CurveSegment<Vec3>[] | string {
  const chain = curveChain(entity.curve);
  if (typeof chain === 'string') return chain;
  const toWorld = (pole: Vec3): Vec3 => applyEulerXYZ(add3(entity.position, pole), entity.position, entity.rotation);
  return chain.map((segment) => mapSegment(segment, toWorld));
}
