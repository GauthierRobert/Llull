/** Design intent of a helix or planar spiral (TECHNICAL_SPEC 3): the definition the NURBS poles approximate and the native kernel builds exactly. */

import type { Vec3 } from '../../model/vectors';
import type { ScalarLaw } from '../law/types';

/**
 * Angle θ runs 0 .. 2π·turns; with φ = startAngle ± θ (− for a left-handed helix) the point is
 * origin + r(u) (cos φ x̂ + sin φ ŷ) + z(θ) axis, u = θ / (2π·turns), r linear from `radius` to `endRadius`, dz/dθ = pitch(u) / 2π (0 for a spiral).
 * @invariant axis is a unit vector; x̂ = `helixFrame(axis).x`; radius, endRadius > 0; turns > 0; a pitch law is positive over u in [0, 1]
 */
export interface HelixDefinition {
  readonly type: 'helix' | 'spiral';
  readonly origin: Vec3;
  readonly axis: Vec3;
  readonly radius: number;
  readonly endRadius: number;
  readonly turns: number;
  /** Axial advance per turn (helix), or the radial advance per turn recorded for a spiral; a law over the turn fraction u. */
  readonly pitch: number | ScalarLaw;
  readonly handedness: 'right' | 'left';
  readonly startAngle: number;
}
