/** Placement of the section at one path station: scale along x / y then rotation about the tangent (laws), or a full 2D affine map (rails). */

import type { Vec2 } from '../../model/types';

/** `[a, b, c, d, dx, dy]`: x' = a x + b y + dx, y' = c x + d y + dy. */
export type Affine2 = readonly [number, number, number, number, number, number];

/**
 * Section placement at one path fraction: scale along x / y (area, scale and stretch folded in) then rotation about the tangent. A rail sweep
 * carries `affine` instead (`sx`, `sy`, `twist` then describe it: the scale factors and rotation of the similarity it came from).
 */
export interface SectionTransform {
  readonly twist: number;
  readonly sx: number;
  readonly sy: number;
  readonly affine?: Affine2;
}

/** Section point under a transform. */
export function transformPoint([x, y]: Vec2, transform: SectionTransform): Vec2 {
  const { twist, sx, sy, affine } = transform;
  if (affine !== undefined) return [affine[0] * x + affine[1] * y + affine[4], affine[2] * x + affine[3] * y + affine[5]];
  const px = x * sx;
  const py = y * sy;
  if (twist === 0) return [px, py];
  const c = Math.cos(twist);
  const s = Math.sin(twist);
  return [px * c - py * s, px * s + py * c];
}

/** The 2D affine map of a transform: its own, or the one its law (scale along x / y, then rotation) describes. */
function asAffine(transform: SectionTransform): Affine2 {
  if (transform.affine !== undefined) return transform.affine;
  const c = Math.cos(transform.twist);
  const s = Math.sin(transform.twist);
  return [c * transform.sx, -s * transform.sy, s * transform.sx, c * transform.sy, 0, 0];
}

/** Transform at weight `u` between `a` and `b` (components mixed linearly; when only one side carries an affine, the other is promoted to its law matrix). */
export function mixTransforms(a: SectionTransform, b: SectionTransform, u: number): SectionTransform {
  const mix = (p: number, q: number): number => p + (q - p) * u;
  let affine: Affine2 | undefined;
  if (a.affine !== undefined || b.affine !== undefined) {
    const [pa, pb] = [asAffine(a), asAffine(b)];
    affine = [mix(pa[0], pb[0]), mix(pa[1], pb[1]), mix(pa[2], pb[2]), mix(pa[3], pb[3]), mix(pa[4], pb[4]), mix(pa[5], pb[5])];
  }
  return { twist: mix(a.twist, b.twist), sx: mix(a.sx, b.sx), sy: mix(a.sy, b.sy), ...(affine === undefined ? {} : { affine }) };
}
