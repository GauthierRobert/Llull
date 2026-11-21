/**
 * Sun shadows and the site ground plane of the raster render (plant 09 VIS-M8, spec 5.6 step 3): an orthographic shadow map looked at along
 * the sun direction, and a finite ground plane at `siteContext.groundElevation` made of cells that receive the shadows.
 * Fixed resolution, fixed iteration order, no randomness: the result is a pure function of (polygons, sun direction).
 * @pure
 */

import type { Vec3 } from '../../model/types';
import type { Polygon3D } from './types';

/** Texels per side of the shadow map (fixed; the map is fitted to the shadow casters, so a texel is extent / 1024). */
export const SHADOW_MAP_SIZE = 1024;
/** Above this many filled polygons the shadow pass is skipped (named in the render summary). Cost: see `docs/plant/09-plant-visualization-review/TECHNICAL_SPEC.md` 12.25. */
export const SHADOW_MAX_POLYGONS = 250_000;
/** The ground plane reaches this share of the scene's largest horizontal extent beyond the scene bounds on every side. */
export const GROUND_MARGIN = 0.5;
/** Ground cells per side (each cell is one shadow-test sample: a shadow edge on the ground is quantised to one cell). */
export const GROUND_CELLS = 96;
/** Ground colour: the `concrete` material class of the defaults (`geometry/materialClasses.ts`); no sky or terrain colour model. */
export const GROUND_COLOR = '#9a9a96';
/** Owner key of the ground cells (no entity id looks like it). */
export const GROUND_OWNER = '__site_ground__';
/** Depth bias in texels: `1 + min(MAX_SLOPE, tan(angle between the face normal and the sun))` (slope-scaled, so a tilted face never shadows itself). */
const MAX_SLOPE = 5;

export interface ShadowMap {
  readonly toSun: Vec3;
  readonly u: Vec3;
  readonly v: Vec3;
  readonly minU: number;
  readonly minV: number;
  readonly texelU: number;
  readonly texelV: number;
  /** Largest depth along `toSun` per texel (-Infinity = nothing). */
  readonly depth: Float64Array;
}

const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
function unit(a: Vec3): Vec3 {
  const length = Math.sqrt(dot(a, a));
  return [a[0] / length, a[1] / length, a[2] / length];
}

/** True for the polygons that cast a shadow (filled faces; section caps and strokes do not). */
const casts = (p: Polygon3D): boolean => !p.stroke && p.loops === undefined && p.verts.length >= 3;

/** World AABB of the filled polygons, or null when there are none. */
export function fillBounds(polygons: readonly Polygon3D[]): { min: Vec3; max: Vec3 } | null {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const polygon of polygons) {
    if (polygon.stroke) continue;
    for (const vert of polygon.verts)
      for (let k = 0; k < 3; k += 1) {
        min[k] = Math.min(min[k] ?? 0, vert[k] ?? 0);
        max[k] = Math.max(max[k] ?? 0, vert[k] ?? 0);
      }
  }
  return min[0] > max[0] ? null : { min, max };
}

/** Shadow map of `polygons` for a sun at unit direction `toSun`, or null when nothing casts. Faces are fan-triangulated (render polygons are convex). */
export function buildShadowMap(polygons: readonly Polygon3D[], toSun: Vec3): ShadowMap | null {
  const reference: Vec3 = Math.abs(toSun[2]) > 0.99 ? [0, 1, 0] : [0, 0, 1];
  const u = unit(cross(reference, toSun));
  const v = cross(toSun, u);
  const casters = polygons.filter(casts);
  let [minU, maxU, minV, maxV] = [Infinity, -Infinity, Infinity, -Infinity];
  for (const polygon of casters)
    for (const vert of polygon.verts) {
      const [pu, pv] = [dot(vert, u), dot(vert, v)];
      [minU, maxU, minV, maxV] = [Math.min(minU, pu), Math.max(maxU, pu), Math.min(minV, pv), Math.max(maxV, pv)];
    }
  if (!(maxU > minU) || !(maxV > minV)) return null;
  const texelU = (maxU - minU) / SHADOW_MAP_SIZE;
  const texelV = (maxV - minV) / SHADOW_MAP_SIZE;
  const depth = new Float64Array(SHADOW_MAP_SIZE * SHADOW_MAP_SIZE).fill(-Infinity);
  for (const polygon of casters) {
    const pts = polygon.verts.map((p) => [(dot(p, u) - minU) / texelU, (dot(p, v) - minV) / texelV, dot(p, toSun)] as const);
    const a = pts[0];
    for (let i = 1; a !== undefined && i + 1 < pts.length; i += 1) {
      const [b, c] = [pts[i], pts[i + 1]];
      if (b !== undefined && c !== undefined) splat(depth, a, b, c);
    }
  }
  return { toSun, u, v, minU, minV, texelU, texelV, depth };
}

type TexelPoint = readonly [number, number, number];

/** Max-depth rasterisation of one triangle (texel centres at +0.5, barycentric, both windings). */
function splat(depth: Float64Array, a: TexelPoint, b: TexelPoint, c: TexelPoint): void {
  const area = (b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]);
  if (!(Math.abs(area) > 1e-12)) return;
  const x0 = Math.max(0, Math.floor(Math.min(a[0], b[0], c[0]) - 0.5));
  const x1 = Math.min(SHADOW_MAP_SIZE - 1, Math.ceil(Math.max(a[0], b[0], c[0]) - 0.5));
  const y0 = Math.max(0, Math.floor(Math.min(a[1], b[1], c[1]) - 0.5));
  const y1 = Math.min(SHADOW_MAP_SIZE - 1, Math.ceil(Math.max(a[1], b[1], c[1]) - 0.5));
  for (let y = y0; y <= y1; y += 1)
    for (let x = x0; x <= x1; x += 1) {
      const [px, py] = [x + 0.5, y + 0.5];
      const wa = ((b[0] - px) * (c[1] - py) - (c[0] - px) * (b[1] - py)) / area;
      const wb = ((c[0] - px) * (a[1] - py) - (a[0] - px) * (c[1] - py)) / area;
      const wc = 1 - wa - wb;
      if (wa < 0 || wb < 0 || wc < 0) continue;
      const d = wa * a[2] + wb * b[2] + wc * c[2];
      const index = y * SHADOW_MAP_SIZE + x;
      if (d > (depth[index] ?? -Infinity)) depth[index] = d;
    }
}

/** True when `point` (on a face with unit `normal` that faces the sun) has geometry between it and the sun; a point outside the map is lit. */
export function inShadow(map: ShadowMap, point: Vec3, normal: Vec3): boolean {
  const x = Math.floor((dot(point, map.u) - map.minU) / map.texelU);
  const y = Math.floor((dot(point, map.v) - map.minV) / map.texelV);
  if (x < 0 || y < 0 || x >= SHADOW_MAP_SIZE || y >= SHADOW_MAP_SIZE) return false;
  const facing = dot(normal, map.toSun);
  if (!(facing > 0)) return false;
  const slope = Math.min(MAX_SLOPE, Math.sqrt(Math.max(0, 1 - facing * facing)) / facing);
  const bias = Math.max(map.texelU, map.texelV) * (1 + slope);
  return (map.depth[y * SHADOW_MAP_SIZE + x] ?? -Infinity) > dot(point, map.toSun) + bias;
}

/** The ground plane at height `z` under `bounds`: GROUND_CELLS² quads (normal +Z) reaching GROUND_MARGIN of the horizontal extent beyond the bounds. */
export function groundCells(bounds: { min: Vec3; max: Vec3 }, z: number): Polygon3D[] {
  const margin = GROUND_MARGIN * Math.max(bounds.max[0] - bounds.min[0], bounds.max[1] - bounds.min[1]);
  if (!(margin > 0) || !Number.isFinite(z)) return [];
  const [x0, y0] = [bounds.min[0] - margin, bounds.min[1] - margin];
  const [sx, sy] = [
    (bounds.max[0] - bounds.min[0] + 2 * margin) / GROUND_CELLS,
    (bounds.max[1] - bounds.min[1] + 2 * margin) / GROUND_CELLS,
  ];
  const cells: Polygon3D[] = [];
  for (let j = 0; j < GROUND_CELLS; j += 1)
    for (let i = 0; i < GROUND_CELLS; i += 1) {
      const [ax, ay, bx, by] = [x0 + i * sx, y0 + j * sy, x0 + (i + 1) * sx, y0 + (j + 1) * sy];
      cells.push({
        verts: [
          [ax, ay, z],
          [bx, ay, z],
          [bx, by, z],
          [ax, by, z],
        ],
        color: GROUND_COLOR,
        normal: [0, 0, 1],
        stroke: false,
        owner: GROUND_OWNER,
        depth: 0,
      });
    }
  return cells;
}
