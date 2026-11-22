/**
 * Receiving side of the raster sun shadows: the shadow test of a point and the pieces a face is shaded in, so only the part of a large face
 * under a caster darkens. Uses the max / min depth pyramids to settle a whole face (all lit, all shadowed) without splitting it.
 * @pure
 */

import type { Vec3 } from '../../model/types';
import type { ShadowMap } from './shadowTypes';
import { SHADOW_MAP_SIZE, depthRange } from './shadowMips';
import { maxOf, minOf } from '../../lib/arrayExtrema';

/** A face whose light-space extent exceeds this many texels is split for shading (4-way, at most `MAX_SPLIT_DEPTH` times) unless the map settles it whole. */
export const PIECE_TEXELS = 8;
const MAX_SPLIT_DEPTH = 7;
/** Cap of the slope term of the depth bias, in texels. */
const MAX_SLOPE = 5;

const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** True when `point` (on a face with unit `normal` that faces the sun) has geometry between it and the sun; a point outside the map is lit. */
export function inShadow(map: ShadowMap, point: Vec3, normal: Vec3): boolean {
  let x = Math.floor((dot(point, map.u) - map.minU) / map.texelU);
  let y = Math.floor((dot(point, map.v) - map.minV) / map.texelV);
  // a point exactly on the max edge belongs to the last texel
  if (x === SHADOW_MAP_SIZE) x -= 1;
  if (y === SHADOW_MAP_SIZE) y -= 1;
  if (x < 0 || y < 0 || x >= SHADOW_MAP_SIZE || y >= SHADOW_MAP_SIZE) return false;
  const facing = dot(normal, map.toSun);
  if (!(facing > 0)) return false;
  // depth change across one texel of a plane with this normal: (|n.u| texelU + |n.v| texelV) / (n.sun), plus half a texel of noise
  const slope = (Math.abs(dot(normal, map.u)) * map.texelU + Math.abs(dot(normal, map.v)) * map.texelV) / facing;
  const texel = Math.max(map.texelU, map.texelV);
  const bias = (map.texelU + map.texelV) / 2 + Math.min(slope, MAX_SLOPE * texel);
  return (map.depth[y * SHADOW_MAP_SIZE + x] ?? -Infinity) > dot(point, map.toSun) + bias;
}

/** One shaded piece of a receiver: its vertices (the whole face when it was not split) and whether the sun is blocked there. */
export interface ShadowPiece {
  readonly verts: readonly Vec3[];
  readonly shadowed: boolean;
}

/** Light-space texel box of `points`: clamped integer range, extent in texels, whether it touches the map and lies wholly inside it. */
function texelBox(
  map: ShadowMap,
  points: readonly Vec3[],
): { x0: number; y0: number; x1: number; y1: number; extent: number; touches: boolean; inside: boolean } {
  let [lo, hi, loV, hiV] = [Infinity, -Infinity, Infinity, -Infinity];
  for (const p of points) {
    const [x, y] = [(dot(p, map.u) - map.minU) / map.texelU, (dot(p, map.v) - map.minV) / map.texelV];
    [lo, hi, loV, hiV] = [Math.min(lo, x), Math.max(hi, x), Math.min(loV, y), Math.max(hiV, y)];
  }
  const last = SHADOW_MAP_SIZE - 1;
  const clamp = (value: number): number => Math.min(last, Math.max(0, Math.floor(value)));
  return {
    x0: clamp(lo),
    y0: clamp(loV),
    x1: clamp(hi),
    y1: clamp(hiV),
    extent: Math.max(hi - lo, hiV - loV),
    touches: hi >= 0 && lo <= SHADOW_MAP_SIZE && hiV >= 0 && loV <= SHADOW_MAP_SIZE,
    inside: lo >= 0 && hi <= SHADOW_MAP_SIZE && loV >= 0 && hiV <= SHADOW_MAP_SIZE,
  };
}

/** `lit` / `dark` when the map settles every point of the face `points` (a conservative test), else null (undecided: split or sample). */
function settle(map: ShadowMap, points: readonly Vec3[], normal: Vec3): { shadowed: boolean; extent: number } | { extent: number } {
  const box = texelBox(map, points);
  if (!box.touches) return { shadowed: false, extent: box.extent };
  const facing = dot(normal, map.toSun);
  const texel = Math.max(map.texelU, map.texelV);
  const biasLow = (map.texelU + map.texelV) / 2;
  const biasHigh = biasLow + MAX_SLOPE * texel;
  const depths = points.map((p) => dot(p, map.toSun));
  const { lo, hi } = depthRange(map, box.x0, box.y0, box.x1, box.y1);
  if (hi <= minOf(depths) + biasLow) return { shadowed: false, extent: box.extent };
  if (box.inside && facing > 0 && lo > maxOf(depths) + biasHigh) return { shadowed: true, extent: box.extent };
  return { extent: box.extent };
}

const mid = (p: Vec3, q: Vec3): Vec3 => [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2, (p[2] + q[2]) / 2];
const centroid = (verts: readonly Vec3[]): Vec3 => {
  let [x, y, z] = [0, 0, 0];
  for (const vert of verts) [x, y, z] = [x + vert[0], y + vert[1], z + vert[2]];
  const n = verts.length || 1;
  return [x / n, y / n, z / n];
};

/**
 * The pieces `verts` (a convex face with unit `normal` facing the sun) is shaded in. A face the map settles whole (nothing above it, or
 * everything above it) or one of at most PIECE_TEXELS texels is one piece with its own vertices; a larger one is fan-triangulated and each
 * triangle split 4-way until the map settles it or its pieces are small, so only the part under a caster darkens. A shadow edge on a large
 * face is quantised to the piece size (up to about PIECE_TEXELS / 2 texels).
 */
export function shadowPieces(map: ShadowMap, verts: readonly Vec3[], normal: Vec3): ShadowPiece[] {
  const whole = settle(map, verts, normal);
  if ('shadowed' in whole) return [{ verts, shadowed: whole.shadowed }];
  if (whole.extent <= PIECE_TEXELS) return [{ verts, shadowed: inShadow(map, centroid(verts), normal) }];
  const pieces: ShadowPiece[] = [];
  const refine = (a: Vec3, b: Vec3, c: Vec3, depth: number): void => {
    const result = settle(map, [a, b, c], normal);
    if ('shadowed' in result) pieces.push({ verts: [a, b, c], shadowed: result.shadowed });
    else if (result.extent <= PIECE_TEXELS || depth >= MAX_SPLIT_DEPTH)
      pieces.push({ verts: [a, b, c], shadowed: inShadow(map, centroid([a, b, c]), normal) });
    else {
      const [ab, bc, ca] = [mid(a, b), mid(b, c), mid(c, a)];
      refine(a, ab, ca, depth + 1);
      refine(ab, b, bc, depth + 1);
      refine(ca, bc, c, depth + 1);
      refine(ab, bc, ca, depth + 1);
    }
  };
  const first = verts[0];
  for (let i = 1; first !== undefined && i + 1 < verts.length; i += 1) {
    const [b, c] = [verts[i], verts[i + 1]];
    if (b !== undefined && c !== undefined) refine(first, b, c, 0);
  }
  return pieces;
}
