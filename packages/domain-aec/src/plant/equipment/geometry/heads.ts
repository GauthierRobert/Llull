/**
 * Formed-head geometry (plant 03 EQP §5.1): resolution of a `HeadSpec` into a shape, inside depth, volume filled to a height above the apex,
 * inside surface area. Closed forms of D. Jones, "Calculating Tank Volume" (via fluids 1.3.1), spheroid area (MathWorld). Lengths in any
 * one consistent unit (the command works in metres).
 */

import { HEAD_STANDARDS } from '../data/headStandards';
import type { HeadSpec } from '../model';

interface TorisphericalGeometry {
  readonly crownRadius: number;
  readonly knuckleRadius: number;
  /** Angle between the axis and the crown/knuckle junction normal. */
  readonly alpha: number;
  /** Depth of the crown part, depth of the knuckle part. */
  readonly crownDepth: number;
  readonly knuckleDepth: number;
}

export type HeadShape =
  | { readonly kind: 'flat'; readonly depth: 0 }
  | { readonly kind: 'ellipsoidal'; readonly depth: number }
  | { readonly kind: 'spherical'; readonly depth: number }
  | { readonly kind: 'conical'; readonly depth: number }
  | ({ readonly kind: 'torispherical'; readonly depth: number } & TorisphericalGeometry);

export interface ResolvedHead {
  readonly shape: HeadShape;
  /** True when a grade B/C standard row was used. */
  readonly unverified: boolean;
  readonly source?: string;
}

export interface HeadRefusal {
  readonly error: string;
  readonly path: string;
}

export const torisphericalGeometry = (radius: number, crownRadius: number, knuckleRadius: number): TorisphericalGeometry => {
  const alpha = Math.asin((radius - knuckleRadius) / (crownRadius - knuckleRadius));
  return {
    crownRadius,
    knuckleRadius,
    alpha,
    crownDepth: crownRadius * (1 - Math.cos(alpha)),
    knuckleDepth: knuckleRadius * Math.cos(alpha),
  };
};

const torispherical = (radius: number, crownRadius: number, knuckleRadius: number): HeadShape => {
  const geometry = torisphericalGeometry(radius, crownRadius, knuckleRadius);
  return { kind: 'torispherical', depth: geometry.crownDepth + geometry.knuckleDepth, ...geometry };
};

/** Shape of a head on a cylinder of inside radius `radius`, or the reason it is invalid (EQP_HEAD_INVALID). */
export function resolveHead(spec: HeadSpec, radius: number, path: string): ResolvedHead | HeadRefusal {
  const diameter = 2 * radius;
  switch (spec.type) {
    case 'flat':
      return { shape: { kind: 'flat', depth: 0 }, unverified: false };
    case 'hemispherical':
      return { shape: { kind: 'spherical', depth: radius }, unverified: false };
    case 'ellipsoidal':
      if (spec.ratio === undefined) return { error: 'ellipsoidal head needs ratio (2 for a 2:1 head)', path: `${path}.ratio` };
      return { shape: { kind: 'ellipsoidal', depth: diameter / (2 * spec.ratio) }, unverified: false };
    case 'conical':
      if (spec.halfAngleDeg === undefined) return { error: 'conical head needs halfAngleDeg', path: `${path}.halfAngleDeg` };
      return { shape: { kind: 'conical', depth: radius / Math.tan((spec.halfAngleDeg * Math.PI) / 180) }, unverified: false };
    case 'torispherical': {
      let crown = spec.crownRadius;
      let knuckle = spec.knuckleRadius;
      let standard: { unverified: boolean; source: string } | undefined;
      if (spec.standard !== undefined) {
        const row = HEAD_STANDARDS[spec.standard];
        crown = row.f * diameter;
        knuckle = row.k * diameter;
        standard = { unverified: row.grade !== 'A', source: `${row.label} (grade ${row.grade}: ${row.sources.join('; ')})` };
      }
      if (crown === undefined || knuckle === undefined) {
        return { error: 'torispherical head needs standard, or crownRadius and knuckleRadius', path: `${path}.standard` };
      }
      if (knuckle >= radius)
        return { error: `knuckle radius ${knuckle} must be below half the diameter ${radius}`, path: `${path}.knuckleRadius` };
      if (crown < radius)
        return { error: `crown radius ${crown} must be at least half the diameter ${radius}`, path: `${path}.crownRadius` };
      if (crown <= knuckle)
        return { error: `crown radius ${crown} must exceed the knuckle radius ${knuckle}`, path: `${path}.crownRadius` };
      return {
        shape: torispherical(radius, crown, knuckle),
        unverified: standard?.unverified ?? false,
        ...(standard ? { source: standard.source } : {}),
      };
    }
  }
}

/** Volume of the torispherical head below height `x` above the apex (Jones: dish, knuckle, then the full head). */
function torisphericalFilled(radius: number, shape: HeadShape & { kind: 'torispherical' }, x: number): number {
  const { crownRadius, knuckleRadius, alpha, crownDepth: a1, knuckleDepth: a2 } = shape;
  if (x <= a1) {
    const d1 = 2 * crownRadius * Math.sin(alpha);
    return ((Math.PI * x * x) / 4) * (2 * a1 + (d1 * d1) / (2 * a1) - (4 * x) / 3);
  }
  const d1 = 2 * crownRadius * Math.sin(alpha);
  const s = (knuckleRadius * Math.sin(alpha)) ** 2;
  const t = 2 * a2;
  const base = (Math.PI / 4) * ((2 * a1 ** 3) / 3 + (a1 * d1 * d1) / 2);
  const knuckle = (radius - knuckleRadius) ** 2 + s;
  const ring = 2 * Math.PI * (radius - knuckleRadius);
  if (x < a1 + a2) {
    const u = x - a1;
    const arc = Math.acos(Math.max(-1, Math.min(1, (t - 2 * u) / (2 * knuckleRadius))));
    return (
      base +
      Math.PI * u * knuckle +
      (Math.PI * t * u * u) / 2 -
      (Math.PI * u ** 3) / 3 +
      ring *
        (((2 * u - t) / 4) * Math.sqrt(Math.max(0, s + t * u - u * u)) + (t * Math.sqrt(s)) / 4 + (knuckleRadius ** 2 / 2) * (arc - alpha))
    );
  }
  return (
    base +
    (Math.PI * t * knuckle) / 2 +
    (Math.PI * t ** 3) / 12 +
    ring * ((t * Math.sqrt(s)) / 4 + (knuckleRadius ** 2 / 2) * Math.asin(Math.cos(alpha)))
  );
}

/** Volume of a head below height `x` above its apex (x clamped to 0..depth), the vessel diameter being 2 x radius. */
export function headFilledVolume(shape: HeadShape, radius: number, x: number): number {
  const level = Math.min(Math.max(x, 0), shape.depth);
  if (level <= 0) return 0;
  const diameter = 2 * radius;
  const a = shape.depth;
  switch (shape.kind) {
    case 'flat':
      return 0;
    case 'ellipsoidal':
      return (Math.PI / 4) * ((diameter * level) / a) ** 2 * (a - level / 3);
    case 'spherical':
      return ((Math.PI * level * level) / 4) * (2 * a + (diameter * diameter) / (2 * a) - (4 * level) / 3);
    case 'conical':
      return ((Math.PI / 4) * ((diameter * level) / a) ** 2 * level) / 3;
    case 'torispherical':
      return torisphericalFilled(radius, shape, level);
  }
}

/** Volume of the whole head (to its tangent line). */
export const headVolume = (shape: HeadShape, radius: number): number => headFilledVolume(shape, radius, shape.depth);

/** Inside surface area of a head (excluding the cylinder). */
export function headInsideArea(shape: HeadShape, radius: number): number {
  const a = shape.depth;
  switch (shape.kind) {
    case 'flat':
      return Math.PI * radius * radius;
    case 'ellipsoidal': {
      if (Math.abs(a - radius) < 1e-15 * radius) return 2 * Math.PI * radius * radius;
      if (a < radius) {
        const e = Math.sqrt(1 - (a * a) / (radius * radius));
        return Math.PI * radius * radius + ((Math.PI * a * a) / (2 * e)) * Math.log((1 + e) / (1 - e));
      }
      const e = Math.sqrt(1 - (radius * radius) / (a * a));
      return Math.PI * radius * radius + ((Math.PI * a * radius) / e) * Math.asin(e);
    }
    case 'spherical':
      return Math.PI * (radius * radius + a * a);
    case 'conical':
      return Math.PI * radius * Math.sqrt(radius * radius + a * a);
    case 'torispherical': {
      const { crownRadius, knuckleRadius, alpha, crownDepth } = shape;
      const crown = 2 * Math.PI * crownRadius * crownDepth;
      const knuckle = 2 * Math.PI * knuckleRadius * ((radius - knuckleRadius) * (Math.PI / 2 - alpha) + knuckleRadius * Math.cos(alpha));
      return crown + knuckle;
    }
  }
}
