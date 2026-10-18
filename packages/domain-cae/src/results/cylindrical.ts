/** Cylindrical components (radial, hoop, axial) of a nodal stress tensor and radial displacement about an axis. */

import type { Vec3 } from '@core/model/vectors';

export interface AxisFrame {
  readonly point: Vec3;
  /** Unit direction of the axis. */
  readonly direction: Vec3;
}

const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
/** On-axis tolerance relative to the distance from the axis point: closer than this the radial direction is undefined. */
const ON_AXIS = 1e-9;

/** The axis through `point` along `direction` (normalised), or null for a zero / non-finite direction. @pure */
export function axisFrame(point: Vec3, direction: Vec3): AxisFrame | null {
  const length = Math.hypot(direction[0], direction[1], direction[2]);
  if (!(length > 0) || !Number.isFinite(length)) return null;
  return { point, direction: [direction[0] / length, direction[1] / length, direction[2] / length] };
}

/** Unit radial vector of `at` (perpendicular to the axis, away from it), or null on the axis. */
function radialOf(at: Vec3, axis: AxisFrame): Vec3 | null {
  const offset: Vec3 = [at[0] - axis.point[0], at[1] - axis.point[1], at[2] - axis.point[2]];
  const along = dot(offset, axis.direction);
  const radial: Vec3 = [
    offset[0] - along * axis.direction[0],
    offset[1] - along * axis.direction[1],
    offset[2] - along * axis.direction[2],
  ];
  const length = Math.hypot(radial[0], radial[1], radial[2]);
  const scale = Math.max(1, Math.hypot(offset[0], offset[1], offset[2]));
  return length > ON_AXIS * scale ? [radial[0] / length, radial[1] / length, radial[2] / length] : null;
}

/** e . S . e for the symmetric tensor [xx, yy, zz, xy, yz, zx]. */
function quadratic(tensor: readonly number[], e: Vec3): number {
  const [xx = 0, yy = 0, zz = 0, xy = 0, yz = 0, zx = 0] = tensor;
  return xx * e[0] * e[0] + yy * e[1] * e[1] + zz * e[2] * e[2] + 2 * (xy * e[0] * e[1] + yz * e[1] * e[2] + zx * e[2] * e[0]);
}

/**
 * Radial, hoop and axial normal stress of `tensor` ([xx, yy, zz, xy, yz, zx], CalculiX order) at `at`.
 * @invariant radial / hoop are NaN on the axis (direction undefined); axial is defined everywhere
 */
export function cylindricalStress(
  tensor: readonly number[],
  at: Vec3,
  axis: AxisFrame,
): { readonly radial: number; readonly hoop: number; readonly axial: number } {
  const axial = quadratic(tensor, axis.direction);
  const radial = radialOf(at, axis);
  if (radial === null) return { radial: Number.NaN, hoop: Number.NaN, axial };
  return { radial: quadratic(tensor, radial), hoop: quadratic(tensor, cross(axis.direction, radial)), axial };
}

/** Displacement component along the radial direction at `at` (NaN on the axis). */
export function cylindricalDisplacement(displacement: readonly number[], at: Vec3, axis: AxisFrame): number {
  const radial = radialOf(at, axis);
  const [ux = 0, uy = 0, uz = 0] = displacement;
  return radial === null ? Number.NaN : ux * radial[0] + uy * radial[1] + uz * radial[2];
}

export const CYLINDRICAL_QUANTITIES = ['s_hoop', 's_radial', 's_axial', 'u_radial'] as const;
export type CylindricalQuantity = (typeof CYLINDRICAL_QUANTITIES)[number];

/** Results field and scalar of a cylindrical quantity (node position `at` in analysis units). */
export const CYLINDRICAL_FIELDS: Readonly<
  Record<
    CylindricalQuantity,
    { readonly field: 'STRESS' | 'DISP'; readonly scalar: (values: readonly number[], at: Vec3, axis: AxisFrame) => number }
  >
> = {
  s_hoop: { field: 'STRESS', scalar: (values, at, axis) => cylindricalStress(values, at, axis).hoop },
  s_radial: { field: 'STRESS', scalar: (values, at, axis) => cylindricalStress(values, at, axis).radial },
  s_axial: { field: 'STRESS', scalar: (values, at, axis) => cylindricalStress(values, at, axis).axial },
  u_radial: { field: 'DISP', scalar: cylindricalDisplacement },
};
