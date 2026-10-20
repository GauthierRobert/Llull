/** Entity-aware helpers of NURBS surface sheets: world placement, display tessellation, pole extent, uniform scaling. */

import type { Vec3 } from '../model/vectors';
import type { NurbsCurveEntity, NurbsSurfaceEntity } from '../model/types';
import { applyEulerXYZ, isZeroRotation } from '../lib/eulerRotation';
import { add3 } from '../lib/vec3';
import { evaluateSurface, mapSurfacePoles } from '../lib/nurbs/surface';
import type { NurbsCurveData } from '../lib/nurbs/types';
import type { NurbsSurfaceData } from '../lib/nurbs/surfaceTypes';

/** Largest number of samples per direction of a display grid. */
const MAX_GRID = 96;

/** `surface` in world coordinates (the entity's rotation about its position, then its position added): exact, poles only. */
export function placedSurface(entity: NurbsSurfaceEntity): NurbsSurfaceData {
  return mapSurfacePoles(entity.surface, (pole) =>
    isZeroRotation(entity.rotation)
      ? add3(entity.position, pole)
      : applyEulerXYZ(add3(entity.position, pole), entity.position, entity.rotation),
  );
}

/** The curve of a `nurbs_curve` entity in world coordinates (see `placedSurface`). */
export function placedCurve(entity: NurbsCurveEntity): NurbsCurveData {
  const place = (pole: Vec3): Vec3 =>
    isZeroRotation(entity.rotation)
      ? add3(entity.position, pole)
      : applyEulerXYZ(add3(entity.position, pole), entity.position, entity.rotation);
  return { ...entity.curve, poles: entity.curve.poles.map(place) };
}

/** Parameter samples of one direction: the same count in every knot span (so creases are resolved), at most MAX_GRID in all. */
function directionSamples(knots: ReadonlyArray<number>, perSpan: number): number[] {
  const spans = knots.length - 1;
  const steps = Math.max(1, Math.min(perSpan, Math.floor((MAX_GRID - 1) / spans)));
  const values: number[] = [knots[0] as number];
  for (let span = 0; span < spans; span++) {
    const [from, to] = [knots[span] as number, knots[span + 1] as number];
    for (let step = 1; step <= steps; step++) values.push(step === steps ? to : from + ((to - from) * step) / steps);
  }
  return values;
}

export interface SurfaceMesh {
  /** x, y, z of every grid vertex, `countV` per row. */
  readonly positions: number[];
  readonly indices: number[];
  readonly countU: number;
  readonly countV: number;
}

/** Display tessellation of `surface` (local frame): `perSpan` quads per knot span per direction, two triangles per quad. */
/** The u and v parameter values of the display grid of `surface` (same count in every knot span, at most 96 per direction). */
export function gridParameters(surface: NurbsSurfaceData, perSpan = 8): { us: number[]; vs: number[] } {
  return { us: directionSamples(surface.knotsU, perSpan), vs: directionSamples(surface.knotsV, perSpan) };
}

export function tessellateSurface(surface: NurbsSurfaceData, perSpan = 8): SurfaceMesh {
  const us = directionSamples(surface.knotsU, perSpan);
  const vs = directionSamples(surface.knotsV, perSpan);
  const positions: number[] = [];
  for (const u of us)
    for (const v of vs) {
      const [x, y, z] = evaluateSurface(surface, u, v);
      positions.push(x, y, z);
    }
  const indices: number[] = [];
  for (let i = 0; i + 1 < us.length; i++)
    for (let j = 0; j + 1 < vs.length; j++) {
      const a = i * vs.length + j;
      const [b, c, d] = [a + 1, a + vs.length, a + vs.length + 1];
      indices.push(a, c, b, b, c, d);
    }
  return { positions, indices, countU: us.length, countV: vs.length };
}

/** Axis-aligned box of the poles; a NURBS patch (positive weights) lies inside its pole hull, so this is a conservative local AABB. */
export function surfacePoleExtent(surface: NurbsSurfaceData): { min: Vec3; max: Vec3 } {
  const poles = surface.poles.flat();
  const axis = (index: 0 | 1 | 2): readonly [number, number] => {
    return [poles.reduce((m, pole) => Math.min(m, pole[index]), Infinity), poles.reduce((m, pole) => Math.max(m, pole[index]), -Infinity)];
  };
  const [x, y, z] = [axis(0), axis(1), axis(2)];
  return { min: [x[0], y[0], z[0]], max: [x[1], y[1], z[1]] };
}

/** `surface` scaled by `factor` about its local origin. */
export function scaleSurface(surface: NurbsSurfaceData, factor: number): NurbsSurfaceData {
  return mapSurfacePoles(surface, ([x, y, z]) => [x * factor, y * factor, z * factor]);
}

/** Triangles of the display tessellation, each as three vertices with `position` added (the form `render_view` rotates and paints). */
export function surfaceTriangles(surface: NurbsSurfaceData, position: Vec3, perSpan = 4): Vec3[][] {
  const { positions, indices } = tessellateSurface(surface, perSpan);
  const vertex = (index: number): Vec3 =>
    add3(position, [positions[3 * index] as number, positions[3 * index + 1] as number, positions[3 * index + 2] as number]);
  const triangles: Vec3[][] = [];
  for (let t = 0; t < indices.length; t += 3)
    triangles.push([vertex(indices[t] as number), vertex(indices[t + 1] as number), vertex(indices[t + 2] as number)]);
  return triangles;
}
