/** Rotational symmetry of a sweep section: the twist that maps it onto itself (closed paths need a whole number of those). */

import type { SweepEntity, Vec2 } from '../../model/types';

/** Highest rotational symmetry order tested. */
const MAX_ORDER = 24;

/** Order k of the rotation by 2π/k that maps the vertex set onto itself, as large as possible (1 = none); Infinity for a round section. */
export function sectionSymmetryOrder(section: SweepEntity['section']): number {
  if (section.shape === 'circle') return Number.POSITIVE_INFINITY;
  const points = section.profile;
  const size = Math.max(...points.map(([x, y]) => Math.hypot(x, y)), 1e-12);
  const tolerance = size * 1e-9;
  const maps = (angle: number): boolean => {
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    return points.every(([x, y]) => points.some(([u, v]: Vec2) => Math.hypot(x * c - y * s - u, x * s + y * c - v) <= tolerance));
  };
  for (let k = MAX_ORDER; k > 1; k--) if (maps((2 * Math.PI) / k)) return k;
  return 1;
}
