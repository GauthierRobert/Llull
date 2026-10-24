/**
 * Decal projection (like three.js DecalGeometry): the solid's triangles facing the decal are clipped to the decal box (±width/2, ±height/2,
 * ±depth/2 around `center`, z along `normal`) and given UVs in glTF convention (u right, v down from the top of the image). The patch is
 * lifted slightly off the surface so it never z-fights. Pure; the viewport and glTF export share it.
 */

import type { Decal, Vec3 } from '../model/types';
import { add3, cross3, dot3, normalize3, scale3, sub3 } from '../lib/vec3';
import { wrapPatch } from './decalWrap';
import { facetNormal } from './tessellation';
import { edgeCrossing, forEachEdge } from './planeEdges';
import type { Triangle } from './triangles';

/** Decal projector axes: x along the text, y up the text, z = outward normal. */
export function decalAxes(decal: Pick<Decal, 'normal' | 'angle'>): { x: Vec3; y: Vec3; z: Vec3 } {
  const z = normalize3(decal.normal);
  const reference: Vec3 = Math.abs(z[2]) < 0.9 ? [0, 0, 1] : [0, 1, 0];
  const x0 = normalize3(cross3(reference, z));
  const y0 = cross3(z, x0);
  const [c, s] = [Math.cos(decal.angle), Math.sin(decal.angle)];
  const x = add3(scale3(x0, c), scale3(y0, s));
  return { x, y: cross3(z, x), z };
}

/** Clip a convex polygon (projector coordinates) to `coordinate[axis] * sign <= limit`. */
function clip(polygon: Vec3[], axis: 0 | 1 | 2, sign: 1 | -1, limit: number): Vec3[] {
  const normal: Vec3 = [axis === 0 ? sign : 0, axis === 1 ? sign : 0, axis === 2 ? sign : 0];
  const out: Vec3[] = [];
  forEachEdge(polygon, { normal, offset: limit }, (a, b, da, db) => {
    if (da <= 0) out.push(a);
    if (da * db < 0) out.push(edgeCrossing(a, b, da, db));
  });
  return out;
}

/**
 * The decal patch over `triangles` (same frame as the decal): triangles with positions and UVs. Only faces turned toward the decal (normal
 * · decal normal > 0.2) receive it.
 */
export function decalPatch(decal: Decal, triangles: readonly Triangle[]): { positions: number[]; uvs: number[] } {
  if (decal.mapping === 'wrap' && decal.wrap !== undefined) return wrapPatch(decal, decal.wrap);
  const { x, y, z } = decalAxes(decal);
  const toLocal = (p: Vec3): Vec3 => {
    const d = sub3(p, decal.center);
    return [dot3(d, x), dot3(d, y), dot3(d, z)];
  };
  const lift = Math.max(decal.width, decal.height) * 1e-3;
  const toWorld = (q: Vec3): Vec3 => add3(decal.center, add3(add3(scale3(x, q[0]), scale3(y, q[1])), scale3(z, q[2] + lift)));
  const positions: number[] = [];
  const uvs: number[] = [];
  const [hw, hh, hd] = [decal.width / 2, decal.height / 2, decal.depth / 2];
  for (const triangle of triangles) {
    if (dot3(facetNormal(...triangle), z) <= 0.2) continue;
    let polygon: Vec3[] = triangle.map(toLocal);
    for (const [axis, limit] of [
      [0, hw],
      [1, hh],
      [2, hd],
    ] as const) {
      polygon = clip(clip(polygon, axis, 1, limit), axis, -1, limit);
      if (polygon.length < 3) break;
    }
    for (let k = 1; k + 1 < polygon.length; k++) {
      for (const q of [polygon[0], polygon[k], polygon[k + 1]] as Vec3[]) {
        positions.push(...toWorld(q));
        uvs.push(q[0] / decal.width + 0.5, 0.5 - q[1] / decal.height);
      }
    }
  }
  return { positions, uvs };
}

/** Scaled copies of `decals` (uniform scale about the entity origin). */
export function scaledDecals(decals: ReadonlyArray<Decal>, factor: number): Decal[] {
  return decals.map((decal) => ({
    ...decal,
    ...(decal.wrap === undefined
      ? {}
      : {
          wrap:
            decal.wrap.type === 'cylinder'
              ? { ...decal.wrap, origin: scale3(decal.wrap.origin, factor), radius: decal.wrap.radius * factor }
              : { ...decal.wrap, apex: scale3(decal.wrap.apex, factor) },
        }),
    center: scale3(decal.center, factor),
    width: decal.width * factor,
    height: decal.height * factor,
    depth: decal.depth * factor,
  }));
}
