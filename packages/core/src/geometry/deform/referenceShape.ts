/** Distance of points to an analytic reference surface (01 DEF `analyze_deformation` compareTo): torus, cylinder, cone, spheroid. Document units. */

import type { Vec3 } from '../../model/vectors';
import { dot3, len3, normalize3, scale3, sub3 } from '../../lib/vec3';

export type ReferenceKind = 'torus' | 'cylinder' | 'cone' | 'spheroid';

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
}

type Distance = (p: Vec3) => number;

/** The fields each kind needs, for the refusal text. */
export const REFERENCE_FIELDS: Readonly<Record<ReferenceKind, readonly string[]>> = {
  torus: ['majorRadius', 'minorRadius', 'center', 'axis'],
  cylinder: ['radius', 'point', 'axis'],
  cone: ['apex', 'axis', 'halfAngleDeg'],
  spheroid: ['center', 'semiAxes'],
};

const positive = (value: number | undefined): value is number => value !== undefined && Number.isFinite(value) && value > 0;

/**
 * Distance function of a reference shape to a point (unsigned), or the name of the first missing / invalid field.
 * torus: | sqrt((rho - R)^2 + h^2) - r |; cylinder: | distance to the axis - r |; cone: | rho cos(a) - h sin(a) | (distance to the generators, the nappe
 * toward the axis direction); spheroid: first-order distance |f| / |grad f| of f = sum (x_i / a_i)^2 - 1.
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
  }
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
