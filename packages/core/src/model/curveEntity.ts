import type { NurbsCurveData } from '../lib/nurbs/types';
import type { NurbsCurveEntity } from './types';

/** The curve entity with its geometry replaced: the helix definition (`analytic`) described the old poles, so it is dropped. */
export function withCurve(entity: NurbsCurveEntity, curve: NurbsCurveData): NurbsCurveEntity {
  const next: NurbsCurveEntity = { ...entity, curve };
  delete next.analytic;
  return next;
}
