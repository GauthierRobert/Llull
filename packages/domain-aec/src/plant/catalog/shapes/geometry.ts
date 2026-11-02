/**
 * Shape building blocks of `component_shape` (plant 01 PSC M4): revolved solids as recipe leaves, tubes along an axis, booleans, and exact bounds
 * from end discs. Every primitive is a surface of revolution (`revolution` entity), so the exact kernel builds true cylinders, cones and torus segments.
 * @invariant pure; bounds are the hull of the discs a primitive is made of (exact for cylinders, frusta, flange profiles and torus segments at their extreme angles)
 */

import type { RevolutionEntity, ShapeRecipe } from '@core/model/types';
import type { Vec3 } from '@core/model/vectors';
import { eulerFromAxes } from '@lib/eulerRotation';
import { cross3, normalize3 } from '@lib/vec3';

/** Through-cuts overshoot the solid by this much so the cut never shares a face with it. */
export const CUT_OVERSHOOT_MM = 1;
const FULL_TURN_SEGMENTS = 48;
const ARC_STEPS_PER_QUARTER = 24;

export type Section = Array<[number, number]>;

/** A circular cross-section: centre, unit normal, radius. The hull of a primitive's discs bounds it. */
export interface Disc {
  readonly centre: Vec3;
  readonly normal: Vec3;
  readonly radius: number;
}

export interface Bounds {
  readonly min: Vec3;
  readonly max: Vec3;
}

const BASE = { layerId: '0', color: '#8f98a3' } as const;

/** Euler angles taking local +Z onto the unit vector `axis`. */
export function rotationToward(axis: Vec3): Vec3 {
  const reference: Vec3 = Math.abs(axis[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const x = normalize3(cross3(reference, axis));
  return eulerFromAxes(x, cross3(axis, x), axis);
}

/** A leaf: `profile` ([radial, axial] points) revolved about the entity's +Z axis. */
export function revolved(
  id: string,
  profile: Section,
  options: { position?: Vec3; rotation?: Vec3; angle?: number; segments?: number; curves?: RevolutionEntity['curves'] } = {},
): ShapeRecipe {
  const entity: RevolutionEntity = {
    id,
    kind: 'revolution',
    ...BASE,
    position: options.position ?? [0, 0, 0],
    rotation: options.rotation ?? [0, 0, 0],
    profile,
    axis: [0, 0, 1],
    angle: options.angle ?? 2 * Math.PI,
    segments: options.segments ?? FULL_TURN_SEGMENTS,
    ...(options.curves === undefined ? {} : { curves: options.curves }),
  };
  return { op: 'solid', entity };
}

/** A cylinder (or tube when `inner` > 0) from `from` along the unit `axis`. */
export function tube(id: string, from: Vec3, axis: Vec3, length: number, outer: number, inner = 0): ShapeRecipe {
  return revolved(
    id,
    [
      [inner, 0],
      [outer, 0],
      [outer, length],
      [inner, length],
    ],
    { position: from, rotation: rotationToward(axis) },
  );
}

export const union = (a: ShapeRecipe, b: ShapeRecipe): ShapeRecipe => ({ op: 'boolean', boolean: 'union', a, b });
export const subtract = (a: ShapeRecipe, b: ShapeRecipe): ShapeRecipe => ({ op: 'boolean', boolean: 'subtract', a, b });

/** Left-folded union of at least one recipe. */
export const unionAll = (parts: readonly [ShapeRecipe, ...ShapeRecipe[]]): ShapeRecipe => parts.slice(1).reduce(union, parts[0]);

/** The two end discs of a tube or frustum along `axis` from `from`. */
export function frustumDiscs(from: Vec3, axis: Vec3, length: number, radiusFrom: number, radiusTo: number): Disc[] {
  const to: Vec3 = [from[0] + axis[0] * length, from[1] + axis[1] * length, from[2] + axis[2] * length];
  return [
    { centre: from, normal: axis, radius: radiusFrom },
    { centre: to, normal: axis, radius: radiusTo },
  ];
}

/** Circular section of a tube of radius `radius` centred at [`bendRadius`, 0] in the (radial, axial) plane, with its exact arcs. */
export function bendSection(
  bendRadius: number,
  radius: number,
  points = 48,
): { section: Section; curves: NonNullable<RevolutionEntity['curves']> } {
  const section: Section = Array.from({ length: points }, (_, k) => {
    const angle = (2 * Math.PI * k) / points;
    return [bendRadius + radius * Math.cos(angle), radius * Math.sin(angle)];
  });
  return {
    section,
    curves: [
      {
        type: 'arc',
        points: [
          [bendRadius + radius, 0],
          [bendRadius, radius],
          [bendRadius - radius, 0],
        ],
      },
      {
        type: 'arc',
        points: [
          [bendRadius - radius, 0],
          [bendRadius, -radius],
          [bendRadius + radius, 0],
        ],
      },
    ],
  };
}

/** A torus segment: the section revolved by `sweepRad` about +Z starting at +X (bend centre at the origin). */
export function bendSolid(id: string, bendRadius: number, radius: number, sweepRad: number): ShapeRecipe {
  const { section, curves } = bendSection(bendRadius, radius);
  return revolved(id, section, {
    angle: sweepRad,
    segments: Math.max(3, Math.ceil((ARC_STEPS_PER_QUARTER * sweepRad) / (Math.PI / 2))),
    curves,
  });
}

/** Discs of a torus segment at the angles where its extent can peak: both ends and every multiple of 90 degrees inside the sweep. */
export function bendDiscs(bendRadius: number, radius: number, sweepRad: number): Disc[] {
  const angles = [0, sweepRad, ...[1, 2, 3].map((k) => (k * Math.PI) / 2).filter((angle) => angle < sweepRad - 1e-9)];
  return angles.map((angle) => ({
    centre: [bendRadius * Math.cos(angle), bendRadius * Math.sin(angle), 0],
    normal: [-Math.sin(angle), Math.cos(angle), 0],
    radius,
  }));
}

/** Axis-aligned bounds of the hull of `discs`: per axis the centre plus or minus radius x sqrt(1 - n_i^2). */
export function boundsOfDiscs(discs: readonly Disc[]): Bounds {
  const lows: [number, number, number] = [Infinity, Infinity, Infinity];
  const highs: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const disc of discs)
    for (const axis of [0, 1, 2] as const) {
      const spread = disc.radius * Math.sqrt(Math.max(0, 1 - disc.normal[axis] ** 2));
      lows[axis] = Math.min(lows[axis], disc.centre[axis] - spread);
      highs[axis] = Math.max(highs[axis], disc.centre[axis] + spread);
    }
  return { min: lows, max: highs };
}

/** Discs of a profile revolved about +Z at `origin`: one per profile point. */
export function profileDiscs(profile: Section, origin: Vec3 = [0, 0, 0]): Disc[] {
  return profile.map(([radial, axial]) => ({ centre: [origin[0], origin[1], origin[2] + axial], normal: [0, 0, 1], radius: radial }));
}

/** Number of leaves and boolean nodes of a recipe tree (for the answer's size). */
export function recipeStats(recipe: ShapeRecipe): { leaves: number; booleans: number } {
  if (recipe.op === 'solid') return { leaves: 1, booleans: 0 };
  if (recipe.op !== 'boolean') return { leaves: 0, booleans: 0 };
  const a = recipeStats(recipe.a);
  const b = recipeStats(recipe.b);
  return { leaves: a.leaves + b.leaves, booleans: a.booleans + b.booleans + 1 };
}
