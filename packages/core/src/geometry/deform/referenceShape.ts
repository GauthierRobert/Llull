/** Distance of points to an analytic reference surface (01 DEF `analyze_deformation` compareTo): torus, cylinder, cone, spheroid, sphere, plane, elliptic cylinder, helicoid. Document units. */

import type { Vec3 } from '../../model/vectors';
import { cross3, dot3, len3, normalize3, scale3, sub3 } from '../../lib/vec3';

export type ReferenceKind = 'torus' | 'cylinder' | 'cone' | 'spheroid' | 'sphere' | 'plane' | 'ellipticCylinder' | 'helicoid';

/** The numbers of a reference shape; which are needed depends on `kind`. */
export interface ReferenceShape {
  readonly kind: ReferenceKind;
  readonly majorRadius?: number | undefined;
  readonly minorRadius?: number | undefined;
  readonly radius?: number | undefined;
  readonly center?: Vec3 | undefined;
  readonly point?: Vec3 | undefined;
  readonly apex?: Vec3 | undefined;
  readonly axis?: Vec3 | undefined;
  readonly halfAngleDeg?: number | undefined;
  readonly semiAxes?: Vec3 | undefined;
  /** plane: unit-less normal; ellipticCylinder / helicoid: `reference` is the direction of the first semi-axis / of the plane normal at the point. */
  readonly normal?: Vec3 | undefined;
  readonly reference?: Vec3 | undefined;
  /** ellipticCylinder: the two semi-axes (along `reference` and across it). */
  readonly radii?: ReadonlyArray<number> | undefined;
  /** helicoid: rotation per unit length along the axis (radians / document unit, counter-clockwise looking down the axis toward the origin positive) and the plane offset. */
  readonly rate?: number | undefined;
  readonly offset?: number | undefined;
}

type Distance = (p: Vec3) => number;

/** The fields each kind needs, for the refusal text. */
export const REFERENCE_FIELDS: Readonly<Record<ReferenceKind, readonly string[]>> = {
  torus: ['majorRadius', 'minorRadius', 'center', 'axis'],
  cylinder: ['radius', 'point', 'axis'],
  cone: ['apex', 'axis', 'halfAngleDeg'],
  spheroid: ['center', 'semiAxes'],
  sphere: ['center', 'radius'],
  plane: ['point', 'normal'],
  ellipticCylinder: ['point', 'axis', 'reference', 'radii'],
  helicoid: ['point', 'axis', 'reference', 'rate'],
};

const positive = (value: number | undefined): value is number => value !== undefined && Number.isFinite(value) && value > 0;

/**
 * Distance function of a reference shape to a point (unsigned), or the name of the first missing / invalid field.
 * torus: | sqrt((rho - R)^2 + h^2) - r |; cylinder: | distance to the axis - r |; cone: | rho cos(a) - h sin(a) | (distance to the generators, the nappe
 * toward the axis direction); spheroid: first-order distance |f| / |grad f| of f = sum (x_i / a_i)^2 - 1; sphere: | |p - c| - r |; plane: |(p - point)·n|;
 * ellipticCylinder: first-order distance of f = (x / a)^2 + (y / b)^2 - 1 in the plane across the axis (x along reference); helicoid: the twisted plane
 * x cos(k z) + y sin(k z) = offset (x along reference, z along axis from point; the image of the plane x = offset under a twist of k per unit length),
 * first-order distance |g| / |grad g|, which is a helicoid when the offset is 0.
 */
export function referenceDistance(reference: ReferenceShape): Distance | { readonly missing: string } {
  const need = (name: string, ok: boolean): { missing: string } | null => (ok ? null : { missing: name });
  switch (reference.kind) {
    case 'torus': {
      const { majorRadius, minorRadius, center, axis } = reference;
      const bad =
        need('majorRadius', positive(majorRadius)) ??
        need('minorRadius', positive(minorRadius)) ??
        need('center', center !== undefined) ??
        need('axis', axis !== undefined && len3(axis) > 0);
      if (bad !== null || center === undefined || axis === undefined || majorRadius === undefined || minorRadius === undefined)
        return bad ?? { missing: 'axis' };
      const u = normalize3(axis);
      return (p) => {
        const d = sub3(p, center);
        const h = dot3(d, u);
        const rho = len3(sub3(d, scale3(u, h)));
        return Math.abs(Math.hypot(rho - majorRadius, h) - minorRadius);
      };
    }
    case 'cylinder': {
      const { radius, point, axis } = reference;
      const bad =
        need('radius', positive(radius)) ?? need('point', point !== undefined) ?? need('axis', axis !== undefined && len3(axis) > 0);
      if (bad !== null || radius === undefined || point === undefined || axis === undefined) return bad ?? { missing: 'axis' };
      const u = normalize3(axis);
      return (p) => {
        const d = sub3(p, point);
        return Math.abs(len3(sub3(d, scale3(u, dot3(d, u)))) - radius);
      };
    }
    case 'cone': {
      const { apex, axis, halfAngleDeg } = reference;
      const bad =
        need('apex', apex !== undefined) ??
        need('axis', axis !== undefined && len3(axis) > 0) ??
        need('halfAngleDeg', halfAngleDeg !== undefined && halfAngleDeg > 0 && halfAngleDeg < 90);
      if (bad !== null || apex === undefined || axis === undefined || halfAngleDeg === undefined) return bad ?? { missing: 'halfAngleDeg' };
      const u = normalize3(axis);
      const alpha = (halfAngleDeg * Math.PI) / 180;
      return (p) => {
        const d = sub3(p, apex);
        const h = dot3(d, u);
        const rho = len3(sub3(d, scale3(u, h)));
        return Math.abs(rho * Math.cos(alpha) - h * Math.sin(alpha));
      };
    }
    case 'spheroid': {
      const { center, semiAxes } = reference;
      const bad = need('center', center !== undefined) ?? need('semiAxes', semiAxes !== undefined && semiAxes.every((a) => positive(a)));
      if (bad !== null || center === undefined || semiAxes === undefined) return bad ?? { missing: 'semiAxes' };
      return (p) => {
        const d = sub3(p, center);
        const f = d.reduce((sum, c, i) => sum + (c / (semiAxes[i] as number)) ** 2, 0) - 1;
        const gradient = Math.hypot(...d.map((c, i) => (2 * c) / (semiAxes[i] as number) ** 2));
        return gradient === 0 ? Math.abs(f) : Math.abs(f) / gradient;
      };
    }
    case 'sphere': {
      const { center, radius } = reference;
      const bad = need('center', center !== undefined) ?? need('radius', positive(radius));
      if (bad !== null || center === undefined || radius === undefined) return bad ?? { missing: 'radius' };
      return (p) => Math.abs(len3(sub3(p, center)) - radius);
    }
    case 'plane': {
      const { point, normal } = reference;
      const bad = need('point', point !== undefined) ?? need('normal', normal !== undefined && len3(normal) > 0);
      if (bad !== null || point === undefined || normal === undefined) return bad ?? { missing: 'normal' };
      const n = normalize3(normal);
      return (p) => Math.abs(dot3(sub3(p, point), n));
    }
    case 'ellipticCylinder': {
      const { point, axis, reference: direction, radii } = reference;
      const bad =
        need('point', point !== undefined) ??
        need('axis', axis !== undefined && len3(axis) > 0) ??
        need('reference', direction !== undefined && axis !== undefined && acrossAxis(direction, axis) !== null) ??
        need('radii', radii !== undefined && radii.length === 2 && radii.every((r) => positive(r)));
      if (bad !== null || point === undefined || axis === undefined || direction === undefined || radii === undefined)
        return bad ?? { missing: 'radii' };
      const frame = planeFrame(axis, direction);
      const [a, b] = [radii[0] as number, radii[1] as number];
      return (p) => {
        const d = sub3(p, point);
        const [x, y] = [dot3(d, frame.x), dot3(d, frame.y)];
        const f = (x / a) ** 2 + (y / b) ** 2 - 1;
        const gradient = Math.hypot((2 * x) / (a * a), (2 * y) / (b * b));
        return gradient === 0 ? Math.abs(f) : Math.abs(f) / gradient;
      };
    }
    case 'helicoid': {
      const { point, axis, reference: direction, rate, offset = 0 } = reference;
      const bad =
        need('point', point !== undefined) ??
        need('axis', axis !== undefined && len3(axis) > 0) ??
        need('reference', direction !== undefined && axis !== undefined && acrossAxis(direction, axis) !== null) ??
        need('rate', rate !== undefined && Number.isFinite(rate)) ??
        need('offset', Number.isFinite(offset));
      if (bad !== null || point === undefined || axis === undefined || direction === undefined || rate === undefined)
        return bad ?? { missing: 'rate' };
      const frame = planeFrame(axis, direction);
      return (p) => {
        const d = sub3(p, point);
        const [x, y, z] = [dot3(d, frame.x), dot3(d, frame.y), dot3(d, frame.z)];
        const [cos, sin] = [Math.cos(rate * z), Math.sin(rate * z)];
        const g = x * cos + y * sin - offset;
        // dg/dz = k (y cos - x sin); the horizontal gradient (cos, sin) has length 1
        const gradient = Math.hypot(1, rate * (y * cos - x * sin));
        return Math.abs(g) / gradient;
      };
    }
  }
}

/** `direction` projected perpendicular to `axis`, or null when it is parallel to it. */
function acrossAxis(direction: Vec3, axis: Vec3): Vec3 | null {
  const z = normalize3(axis);
  const across = sub3(direction, scale3(z, dot3(direction, z)));
  return len3(across) > 1e-9 * len3(direction) ? normalize3(across) : null;
}

/** Orthonormal frame with z along `axis` and x the direction projected across it (y = z cross x). */
function planeFrame(axis: Vec3, direction: Vec3): { x: Vec3; y: Vec3; z: Vec3 } {
  const z = normalize3(axis);
  const x = acrossAxis(direction, axis) as Vec3;
  return { x, y: cross3(z, x), z };
}

/** Largest distance from `positions` (xyz triples) to the reference, over at most `limit` points (a stride beyond). */
export function maxDeviation(distance: Distance, positions: ReadonlyArray<number>, limit = 200_000): { max: number; samples: number } {
  const count = positions.length / 3;
  const stride = Math.max(1, Math.ceil(count / limit));
  let max = 0;
  let samples = 0;
  for (let v = 0; v < count; v += stride) {
    max = Math.max(max, distance([positions[3 * v] as number, positions[3 * v + 1] as number, positions[3 * v + 2] as number]));
    samples++;
  }
  return { max, samples };
}
