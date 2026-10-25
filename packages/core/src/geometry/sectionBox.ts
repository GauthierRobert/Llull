/**
 * Section box maths (plant 09 VIS §5.4): validation of a box / half-space section and the classification of an entity AABB against it. Pure.
 * @invariant a box turned by rotationZ is tested in its own frame (the AABB corners rotated by −θ about the box centre): exact for θ = 0, a
 *   conservative bound of the rotated AABB otherwise; touching counts as crossing
 */

import type { SectionBox, SectionPlane } from '../model/review';
import type { Vec3 } from '../model/vectors';
import { dot3, len3, scale3 } from '../lib/vec3';
import { boundsCorners, type Bounds } from './bounds';

export type SectionClass = 'inside' | 'crossing' | 'outside';

export const MAX_SECTION_PLANES = 6;

const finite = (v: readonly number[]): boolean => v.every(Number.isFinite);

/** The reason `box` is not exactly one valid form (box or planes), or null. */
export function sectionBoxProblem(box: {
  readonly min?: Vec3 | undefined;
  readonly max?: Vec3 | undefined;
  readonly rotationZ?: number | undefined;
  readonly planes?: readonly SectionPlane[] | undefined;
}): string | null {
  const { min, max, planes, rotationZ } = box;
  if (planes !== undefined) {
    if (min !== undefined || max !== undefined || rotationZ !== undefined) return 'give planes or min / max, not both';
    if (planes.length < 1 || planes.length > MAX_SECTION_PLANES) return `planes needs 1..${MAX_SECTION_PLANES} entries`;
    return planes.every((plane) => finite(plane.normal) && len3(plane.normal) > 1e-12 && Number.isFinite(plane.offset))
      ? null
      : 'every plane needs a finite non-zero normal and a finite offset';
  }
  if (min === undefined || max === undefined) return 'give min and max, or planes';
  if (!finite(min) || !finite(max)) return 'min and max must be finite';
  if (!min.every((value, axis) => value < (max[axis] ?? Number.NaN))) return 'min must be below max on every axis';
  return rotationZ === undefined || Number.isFinite(rotationZ) ? null : 'rotationZ must be finite';
}

/** Planes with unit normals (offset scaled to match). */
export const normalizeSectionPlanes = (planes: readonly SectionPlane[]): SectionPlane[] =>
  planes.map(({ normal, offset }) => {
    const length = len3(normal);
    return { normal: scale3(normal, 1 / length) as Vec3, offset: offset / length };
  });

function classifyPlanes(planes: readonly SectionPlane[], corners: readonly Vec3[]): SectionClass {
  let crossing = false;
  for (const { normal, offset } of planes) {
    const sides = corners.map((corner) => dot3(normal, corner) - offset);
    if (sides.every((side) => side > 0)) return 'outside';
    if (sides.some((side) => side > 0)) crossing = true;
  }
  return crossing ? 'crossing' : 'inside';
}

/** Where `bounds` lies against `box` (assumes a valid box). */
export function classifyAgainstSection(box: SectionBox, bounds: Bounds): SectionClass {
  const corners = boundsCorners(bounds);
  if (box.planes !== undefined) return classifyPlanes(box.planes, corners);
  const { min, max } = box;
  if (min === undefined || max === undefined) return 'crossing';
  const angle = box.rotationZ ?? 0;
  const centre = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2];
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const local = corners.map((corner): Vec3 => {
    const dx = corner[0] - (centre[0] ?? 0);
    const dy = corner[1] - (centre[1] ?? 0);
    return [(centre[0] ?? 0) + dx * cos + dy * sin, (centre[1] ?? 0) - dx * sin + dy * cos, corner[2]];
  });
  const axes = [0, 1, 2] as const;
  const lows = axes.map((axis) => Math.min(...local.map((point) => point[axis])));
  const highs = axes.map((axis) => Math.max(...local.map((point) => point[axis])));
  if (axes.some((axis) => (highs[axis] ?? 0) < min[axis] || (lows[axis] ?? 0) > max[axis])) return 'outside';
  return axes.every((axis) => (lows[axis] ?? 0) >= min[axis] && (highs[axis] ?? 0) <= max[axis]) ? 'inside' : 'crossing';
}
