/** NURBS curve data (SRF §3): a clamped, non-periodic B-spline in 3D, optionally rational. Poles are local to the owning entity. */

import type { Vec3 } from '../../model/vectors';

/** Highest supported degree (OCC `Geom_BSplineCurve::MaxDegree`). */
export const MAX_NURBS_DEGREE = 25;

/**
 * @invariant clamped: first and last knot have multiplicity degree + 1; Σ multiplicities = poles.length + degree + 1; knots strictly
 *   increasing; weights (when present) finite > 0 with one per pole; no periodic curves (a closed curve repeats its end pole)
 */
export interface NurbsCurveData {
  readonly degree: number;
  readonly poles: ReadonlyArray<Vec3>;
  readonly weights?: ReadonlyArray<number>;
  readonly knots: ReadonlyArray<number>;
  readonly multiplicities: ReadonlyArray<number>;
}
