/**
 * Sun shadows and the site ground plane of the raster render (plant 09 VIS-M8, spec 5.6 step 3): an orthographic shadow map looked at along
 * the sun direction, receivers shaded per piece (`shadowReceivers.ts`), and a finite ground plane at `siteContext.groundElevation`.
 * Fixed resolution, fixed iteration order, no randomness: the result is a pure function of (polygons, sun direction).
 * @pure
 */

import type { Vec3 } from '../../model/types';
import type { Polygon3D } from './types';
import type { ShadowPlan, SunShadowReport } from './shadowTypes';
import { SHADOW_MAP_SIZE, buildMips } from './shadowMips';
import type { RenderLight } from './camera';

/**
 * Work limit of the shadow pass: summed texels covered by the casters' triangles plus the rows they span (the cost of `splat`). Above it the
 * pass is skipped and the summary names it. About 3 s of map build (measured, TECHNICAL_SPEC 12.25).
 */
export const SHADOW_MAX_WORK = 150_000_000;
/** The ground plane reaches this share of the scene's largest horizontal extent beyond the scene bounds on every side. */
export const GROUND_MARGIN = 0.5;
/** The plane sits this share of the scene radius below `groundElevation`, so a model face on the ground level keeps all its pixels (no z-fight). */
export const GROUND_DROP = 1e-4;
/** Ground colour: the `concrete` material class of the defaults (`geometry/materialClasses.ts`); no sky or terrain colour model. */
export const GROUND_COLOR = '#9a9a96';
/** Owner key of the ground plane (no entity id looks like it). */
export const GROUND_OWNER = '__site_ground__';

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

type TexelPoint = readonly [number, number, number];

/** Twice the signed area of a texel triangle. */
const area2 = (a: TexelPoint, b: TexelPoint, c: TexelPoint): number => (b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]);

/** Texels a triangle fills plus the rows it spans (the work of `splat`). */
const triangleWork = (a: TexelPoint, b: TexelPoint, c: TexelPoint): number =>
  Math.abs(area2(a, b, c)) / 2 + Math.max(a[1], b[1], c[1]) - Math.min(a[1], b[1], c[1]) + 1;

/** Visits the fan triangles of every caster, in texel coordinates of the light basis (`origin` = minU, minV; `texel` sizes). */
function forEachTriangle(
  casters: readonly Polygon3D[],
  basis: { u: Vec3; v: Vec3; toSun: Vec3; minU: number; minV: number; texelU: number; texelV: number },
  visit: (a: TexelPoint, b: TexelPoint, c: TexelPoint) => void,
): void {
  const { u, v, toSun, minU, minV, texelU, texelV } = basis;
  for (const polygon of casters) {
    const pts = polygon.verts.map((p) => [(dot(p, u) - minU) / texelU, (dot(p, v) - minV) / texelV, dot(p, toSun)] as const);
    const a = pts[0];
    for (let i = 1; a !== undefined && i + 1 < pts.length; i += 1) {
      const [b, c] = [pts[i], pts[i + 1]];
      if (b !== undefined && c !== undefined) visit(a, b, c);
    }
  }
}

/** Exact content key of the casters and the sun (every float's bits, two 32-bit hashes): equal key = equal map. */
function contentKey(casters: readonly Polygon3D[], toSun: Vec3): string {
  const scratch = new Float64Array(3);
  const bits = new Uint32Array(scratch.buffer);
  let [h1, h2] = [0x811c9dc5, 0x01000193];
  const mix = (value: number): void => {
    h1 = Math.imul(h1 ^ value, 0x01000193) >>> 0;
    h2 = Math.imul(h2 + value, 0x85ebca6b) >>> 0;
    h2 ^= h2 >>> 13;
  };
  const feed = (p: Vec3): void => {
    scratch.set(p);
    for (let k = 0; k < 6; k += 1) mix(bits[k] ?? 0);
  };
  feed(toSun);
  for (const polygon of casters) {
    mix(polygon.verts.length);
    for (const vert of polygon.verts) feed(vert);
  }
  return `${casters.length}:${h1}:${h2}`;
}

let lastPlan: { key: string; plan: ShadowPlan } | null = null;

/**
 * The shadow pass of `polygons` for a sun at unit direction `toSun`. The last result is kept by an exact content key, so frames that only move
 * the camera (walkthrough, animation with a static scene) reuse the map. Faces are fan-triangulated (render polygons are convex).
 */
export function planShadows(polygons: readonly Polygon3D[], toSun: Vec3): ShadowPlan {
  const casters = polygons.filter(casts);
  if (casters.length === 0) return { kind: 'empty', work: 0 };
  const key = contentKey(casters, toSun);
  if (lastPlan !== null && lastPlan.key === key) return lastPlan.plan;
  const plan = computePlan(casters, toSun);
  lastPlan = { key, plan };
  return plan;
}

function computePlan(casters: readonly Polygon3D[], toSun: Vec3): ShadowPlan {
  const reference: Vec3 = Math.abs(toSun[2]) > 0.99 ? [0, 1, 0] : [0, 0, 1];
  const u = unit(cross(reference, toSun));
  const v = cross(toSun, u);
  let [minU, maxU, minV, maxV] = [Infinity, -Infinity, Infinity, -Infinity];
  for (const polygon of casters)
    for (const vert of polygon.verts) {
      const [pu, pv] = [dot(vert, u), dot(vert, v)];
      [minU, maxU, minV, maxV] = [Math.min(minU, pu), Math.max(maxU, pu), Math.min(minV, pv), Math.max(maxV, pv)];
    }
  if (!(maxU > minU) || !(maxV > minV)) return { kind: 'empty', work: 0 };
  const basis = { u, v, toSun, minU, minV, texelU: (maxU - minU) / SHADOW_MAP_SIZE, texelV: (maxV - minV) / SHADOW_MAP_SIZE };
  let work = 0;
  forEachTriangle(casters, basis, (a, b, c) => {
    work += triangleWork(a, b, c);
  });
  if (work > SHADOW_MAX_WORK) return { kind: 'skipped', work };
  const depth = new Float64Array(SHADOW_MAP_SIZE * SHADOW_MAP_SIZE).fill(-Infinity);
  forEachTriangle(casters, basis, (a, b, c) => splat(depth, a, b, c));
  return { kind: 'map', work, map: { ...basis, depth, ...buildMips(depth) } };
}

/** Max-depth rasterisation of one triangle: per texel row only the covered span (texel centres at +0.5, edges inclusive). */
function splat(depth: Float64Array, a: TexelPoint, b: TexelPoint, c: TexelPoint): void {
  const area = area2(a, b, c);
  if (!(Math.abs(area) > 1e-12)) return;
  const dzdx = ((b[2] - a[2]) * (c[1] - a[1]) - (c[2] - a[2]) * (b[1] - a[1])) / area;
  const dzdy = ((c[2] - a[2]) * (b[0] - a[0]) - (b[2] - a[2]) * (c[0] - a[0])) / area;
  const y0 = Math.max(0, Math.ceil(Math.min(a[1], b[1], c[1]) - 0.5));
  const y1 = Math.min(SHADOW_MAP_SIZE - 1, Math.floor(Math.max(a[1], b[1], c[1]) - 0.5));
  const edges: readonly [TexelPoint, TexelPoint][] = [
    [a, b],
    [b, c],
    [c, a],
  ];
  for (let y = y0; y <= y1; y += 1) {
    const py = y + 0.5;
    let [left, right] = [Infinity, -Infinity];
    for (const [p, q] of edges) {
      if ((p[1] > py && q[1] > py) || (p[1] < py && q[1] < py) || p[1] === q[1]) continue;
      const x = p[0] + ((py - p[1]) / (q[1] - p[1])) * (q[0] - p[0]);
      [left, right] = [Math.min(left, x), Math.max(right, x)];
    }
    const x0 = Math.max(0, Math.ceil(left - 0.5));
    const x1 = Math.min(SHADOW_MAP_SIZE - 1, Math.floor(right - 0.5));
    for (let x = x0; x <= x1; x += 1) {
      const d = a[2] + dzdx * (x + 0.5 - a[0]) + dzdy * (py - a[1]);
      const index = y * SHADOW_MAP_SIZE + x;
      if (d > (depth[index] ?? -Infinity)) depth[index] = d;
    }
  }
}

/** `light` with the shadow pass of `polygons` run once (so the raster stage and the summary agree), and what it did; unchanged without `light.shadows` or with the sun down. */
export function withSunPlan(
  light: RenderLight | undefined,
  polygons: readonly Polygon3D[],
): { light: RenderLight | undefined; report: SunShadowReport | undefined } {
  if (light?.shadows === undefined || light.direction === null) return { light, report: undefined };
  const plan = planShadows(polygons, light.direction);
  return {
    light: { ...light, shadows: { ...light.shadows, plan } },
    report: { state: plan.kind === 'map' ? 'drawn' : plan.kind, work: plan.work },
  };
}

/** The ground plane at `z` below `drop` under `bounds` (one +Z quad reaching GROUND_MARGIN of the horizontal extent beyond it on every side), or null for a flat scene. */
export function groundPlane(bounds: { min: Vec3; max: Vec3 }, z: number, drop: number): Polygon3D | null {
  const margin = GROUND_MARGIN * Math.max(bounds.max[0] - bounds.min[0], bounds.max[1] - bounds.min[1]);
  if (!(margin > 0) || !Number.isFinite(z)) return null;
  const [x0, y0, x1, y1, zg] = [bounds.min[0] - margin, bounds.min[1] - margin, bounds.max[0] + margin, bounds.max[1] + margin, z - drop];
  return {
    verts: [
      [x0, y0, zg],
      [x1, y0, zg],
      [x1, y1, zg],
      [x0, y1, zg],
    ],
    color: GROUND_COLOR,
    normal: [0, 0, 1],
    stroke: false,
    owner: GROUND_OWNER,
    depth: 0,
  };
}
