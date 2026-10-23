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

/** Transform at weight `u` between `a` and `b` (components mixed linearly). */
export function mixTransforms(a: SectionTransform, b: SectionTransform, u: number): SectionTransform {
  const mix = (p: number, q: number): number => p + (q - p) * u;
  const affine: Affine2 | undefined =
    a.affine === undefined || b.affine === undefined
      ? undefined
      : [
          mix(a.affine[0], b.affine[0]),
          mix(a.affine[1], b.affine[1]),
          mix(a.affine[2], b.affine[2]),
          mix(a.affine[3], b.affine[3]),
          mix(a.affine[4], b.affine[4]),
          mix(a.affine[5], b.affine[5]),
        ];
  return { twist: mix(a.twist, b.twist), sx: mix(a.sx, b.sx), sy: mix(a.sy, b.sy), ...(affine === undefined ? {} : { affine }) };
}
