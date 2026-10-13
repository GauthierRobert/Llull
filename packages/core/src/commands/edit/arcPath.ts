/**
 * Circular-arc path for `pattern_along_path`: the sweep from `startAngle` to `endAngle` about `center` in the plane normal to `normal`, as
 * exact arc segments (a full turn is a closed loop).
 */

import type { CurveSegment } from '../../model/curve';
import type { Vec3 } from '../../model/types';
import { add3, cross3, dot3, isVec3, len3, normalize3, scale3, sub3 } from '../../lib/vec3';

export interface ArcSpec {
  readonly center: readonly number[];
  readonly normal: readonly number[];
  readonly radius: number;
  readonly startAngle: number;
  readonly endAngle: number;
}

/** Unit vector perpendicular to `n`: the arc plane's local +X (angle origin). */
function inPlaneX(n: Vec3): Vec3 {
  const candidate: Vec3 = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  return normalize3(sub3(candidate, scale3(n, dot3(candidate, n))));
}

/**
 * Arc segments from an `ArcSpec` (angles counter-clockwise about `normal`), or a message.
 * @failure radius <= 0, non-finite angle, bad center, zero normal -> message
 */
export function arcPath(arc: ArcSpec): CurveSegment<Vec3>[] | string {
  const { center, normal, radius, startAngle, endAngle } = arc;
  if (!isVec3(center)) return 'arc center must be a finite [x, y, z] triple';
  if (!isVec3(normal) || len3(normal) < 1e-10) return 'arc normal must be a non-zero vector';
  if (!(radius > 0)) return `arc radius must be > 0 (got ${radius})`;
  if (!Number.isFinite(startAngle) || !Number.isFinite(endAngle)) return 'arc angles must be finite numbers';
  const n = normalize3(normal);
  const u = inPlaneX(n);
  const v = cross3(n, u);
  const at = (angle: number): Vec3 => add3(center, scale3(add3(scale3(u, Math.cos(angle)), scale3(v, Math.sin(angle))), radius));
  const sweep = endAngle - startAngle;
  const full = Math.abs(sweep) >= Math.PI * 2 - 1e-9;
  const total = full ? Math.sign(sweep) * Math.PI * 2 : sweep;
  const pieces = full ? 2 : 1;
  return Array.from({ length: pieces }, (_, i): CurveSegment<Vec3> => {
    const a = startAngle + (total * i) / pieces;
    const b = startAngle + (total * (i + 1)) / pieces;
    return { type: 'arc', points: [at(a), at((a + b) / 2), at(b)] };
  });
}
