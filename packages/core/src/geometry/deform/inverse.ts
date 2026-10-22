/** Closed-form inverses of the axis laws (01 DEF §5.2): the source point that a deformed point came from, used to measure a stored result against the map. */

import type { DeformLaw, DeformRegion } from '../../model/deform';
import type { Vec3 } from '../../model/vectors';
import { rampAt } from './region';

/** Inverse of the bend: polar coordinates around the centre of curvature inside the swept sector, a rigid rotation past it. */
function unbend(radius: number, symmetric: boolean, region: DeformRegion, [x, y, z]: Vec3): Vec3 {
  const { start, end } = region;
  const total = (end - start) / radius;
  let dy = y - radius;
  let dz = z - start;
  if (symmetric) {
    const [hs, hc] = [Math.sin(total / 2), Math.cos(total / 2)];
    dz -= (end - start) / 2;
    [dy, dz] = [hc * dy + hs * dz, -hs * dy + hc * dz];
  }
  const angle = Math.atan2(dz, -dy);
  if (angle <= 0) return [x, radius + dy, start + dz];
  if (angle <= total) return [x, radius - Math.hypot(dy, dz), start + radius * angle];
  const [sin, cos] = [Math.sin(total), Math.cos(total)];
  return [x, radius + cos * dy - sin * dz, end + sin * dy + cos * dz];
}

/**
 * The local point that `mapLocal` sends to `q`.
 * @failure the affine law (use its matrix inverse) -> null
 */
export function unmapLocal(law: DeformLaw, region: DeformRegion, q: Vec3): Vec3 | null {
  const [x, y, z] = q;
  switch (law.kind) {
    case 'affine':
      return null;
    case 'twist': {
      const theta = law.angleRad * rampAt(region, z).w;
      const [sin, cos] = [Math.sin(theta), Math.cos(theta)];
      return [x * cos + y * sin, -x * sin + y * cos, z];
    }
    case 'taper': {
      const s = 1 + (law.scaleEnd - 1) * rampAt(region, z).w;
      return [x / s, law.flat ? y : y / s, z];
    }
    case 'stretch': {
      if (z <= region.start) return q;
      const stretchedEnd = region.start + law.factor * (region.end - region.start);
      if (z <= stretchedEnd) return [x, y, region.start + (z - region.start) / law.factor];
      return [x, y, z - (law.factor - 1) * (region.end - region.start)];
    }
    case 'bend':
      return unbend(law.radius, law.symmetric, region, q);
  }
}
