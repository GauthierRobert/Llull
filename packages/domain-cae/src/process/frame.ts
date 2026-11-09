/** Build frame of an AM case: z = the build direction, x / y deterministic from the document axes. */

import type { Vec3 } from '@core/model/vectors';
import { cross3, dot3, len3 } from '@lib/vec3';

/** Local axes `[x, y, z]` (unit, right-handed, z = `build` which must be a unit vector): x is the document X axis made orthogonal to z (document Y when z is within 0.9 of X). */
export function buildFrame(build: Vec3): readonly [Vec3, Vec3, Vec3] {
  const hint: Vec3 = Math.abs(build[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const along = dot3(hint, build);
  const raw: Vec3 = [hint[0] - along * build[0], hint[1] - along * build[1], hint[2] - along * build[2]];
  const length = len3(raw);
  const x: Vec3 = [raw[0] / length, raw[1] / length, raw[2] / length];
  return [x, cross3(build, x), build];
}
