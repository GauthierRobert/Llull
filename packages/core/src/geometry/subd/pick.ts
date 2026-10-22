/**
 * Picking of cage elements for the viewport and for `select_cage_elements` (04 DIR §5.9): nearest vertex / edge / face to a point, and
 * vertex / edge / face under a ray. All inputs are in entity-local coordinates; ids come from the entity's element ids. Pure.
 */

import type { SubdivisionEntity, Vec3 } from '../../model/types';
import { add3, cross3, distance3, dot3, scale3, sub3 } from '../../lib/vec3';
import { inverseEulerXYZ } from '../../lib/eulerRotation';
import { edgeIdOf } from './elements';
import { buildTopology } from './topology';

export interface Ray {
  readonly origin: Vec3;
  /** Need not be unit length. */
  readonly direction: Vec3;
}

export interface CagePick {
  readonly face: { readonly id: string; readonly index: number; readonly distance: number; readonly point: Vec3 } | null;
  /** `t` (pickCage only): ray parameter of the closest approach, for occlusion tests against `face.distance`. */
  readonly vertex: { readonly id: string; readonly index: number; readonly distance: number; readonly t?: number } | null;
  readonly edge: {
    readonly id: string;
    readonly index: number;
    readonly a: number;
    readonly b: number;
    readonly distance: number;
    readonly t?: number;
  } | null;
}

/** Closest point of segment a-b to `p`, and its distance. */
export function nearestOnSegment(p: Vec3, a: Vec3, b: Vec3): { point: Vec3; distance: number } {
  const ab = sub3(b, a);
  const lengthSquared = dot3(ab, ab);
  const t = lengthSquared < 1e-30 ? 0 : Math.min(1, Math.max(0, dot3(sub3(p, a), ab) / lengthSquared));
  const point = add3(a, scale3(ab, t));
  return { point, distance: distance3(p, point) };
}

/** Closest point of triangle a-b-c to `p` (Ericson, Real-Time Collision Detection 5.1.5). */
export function nearestOnTriangle(p: Vec3, a: Vec3, b: Vec3, c: Vec3): Vec3 {
  const [ab, ac, ap] = [sub3(b, a), sub3(c, a), sub3(p, a)];
  const [d1, d2] = [dot3(ab, ap), dot3(ac, ap)];
  if (d1 <= 0 && d2 <= 0) return a;
  const bp = sub3(p, b);
  const [d3, d4] = [dot3(ab, bp), dot3(ac, bp)];
  if (d3 >= 0 && d4 <= d3) return b;
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) return add3(a, scale3(ab, d1 / (d1 - d3)));
  const cp = sub3(p, c);
  const [d5, d6] = [dot3(ab, cp), dot3(ac, cp)];
  if (d6 >= 0 && d5 <= d6) return c;
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) return add3(a, scale3(ac, d2 / (d2 - d6)));
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) return add3(b, scale3(sub3(c, b), (d4 - d3) / (d4 - d3 + (d5 - d6))));
  const denominator = 1 / (va + vb + vc);
  return add3(a, add3(scale3(ab, vb * denominator), scale3(ac, vc * denominator)));
}

/** Nearest cage vertex, edge and face to `p` (entity-local). */
export function nearestCageElements(entity: SubdivisionEntity, p: Vec3): CagePick {
  const topology = buildTopology(entity.vertices.length, entity.faces);
  let vertex: CagePick['vertex'] = null;
  entity.vertices.forEach((q, index) => {
    const distance = distance3(p, q);
    if (vertex === null || distance < vertex.distance) vertex = { id: entity.elementIds.vertices[index] as string, index, distance };
  });
  let edge: CagePick['edge'] = null;
  topology.edges.forEach(({ a, b }, index) => {
    const { distance } = nearestOnSegment(p, entity.vertices[a] as Vec3, entity.vertices[b] as Vec3);
    if (edge === null || distance < edge.distance) edge = { id: edgeIdOf(entity.elementIds, a, b), index, a, b, distance };
  });
  let face: CagePick['face'] = null;
  entity.faces.forEach((loop, index) => {
    for (let k = 1; k + 1 < loop.length; k++) {
      const [a, b, c] = [loop[0], loop[k], loop[k + 1]].map((v) => entity.vertices[v as number] as Vec3) as [Vec3, Vec3, Vec3];
      const point = nearestOnTriangle(p, a, b, c);
      const distance = distance3(p, point);
      if (face === null || distance < face.distance) face = { id: entity.elementIds.faces[index] as string, index, distance, point };
    }
  });
  return { vertex, edge, face };
}

/** Parameter t >= 0 where the ray meets triangle a-b-c (either side), or null (Moeller-Trumbore). */
function rayTriangle(ray: Ray, a: Vec3, b: Vec3, c: Vec3): number | null {
  const [e1, e2] = [sub3(b, a), sub3(c, a)];
  const h = cross3(ray.direction, e2);
  const det = dot3(e1, h);
  if (Math.abs(det) < 1e-14) return null;
  const s = sub3(ray.origin, a);
  const u = dot3(s, h) / det;
  if (u < 0 || u > 1) return null;
  const q = cross3(s, e1);
  const v = dot3(ray.direction, q) / det;
  if (v < 0 || u + v > 1) return null;
  const t = dot3(e2, q) / det;
  return t >= 0 ? t : null;
}

/** Distance of point `p` from the ray (the ray starts at its origin). */
function rayDistanceToPoint(ray: Ray, p: Vec3): { distance: number; t: number } {
  const d = sub3(p, ray.origin);
  const t = Math.max(0, dot3(d, ray.direction) / dot3(ray.direction, ray.direction));
  return { distance: distance3(p, add3(ray.origin, scale3(ray.direction, t))), t };
}

/** Smallest distance between the ray and segment a-b (sampled by closest-approach of the infinite lines, clamped to the segment). */
function rayDistanceToSegment(ray: Ray, a: Vec3, b: Vec3): { distance: number; t: number } {
  const [u, v, w] = [ray.direction, sub3(b, a), sub3(ray.origin, a)];
  const [uu, uv, vv, uw, vw] = [dot3(u, u), dot3(u, v), dot3(v, v), dot3(u, w), dot3(v, w)];
  const determinant = uu * vv - uv * uv;
  let s = determinant < 1e-14 ? 0 : (uv * vw - vv * uw) / determinant;
  s = Math.max(0, s);
  let t = vv < 1e-30 ? 0 : (uv * s + vw) / vv;
  t = Math.min(1, Math.max(0, t));
  s = Math.max(0, (uv * t - uw) / uu);
  return { distance: distance3(add3(ray.origin, scale3(u, s)), add3(a, scale3(v, t))), t: s };
}

/**
 * What a ray (entity-local) points at: the nearest face it crosses (`distance` = ray parameter), and the vertex / edge closest to the ray
 * within `tolerance` (local units; `distance` = distance from the ray, `t` = ray parameter of the closest approach).
 */
export function pickCage(entity: SubdivisionEntity, ray: Ray, tolerance: number): CagePick {
  const topology = buildTopology(entity.vertices.length, entity.faces);
  let face: CagePick['face'] = null;
  entity.faces.forEach((loop, index) => {
    for (let k = 1; k + 1 < loop.length; k++) {
      const [a, b, c] = [loop[0], loop[k], loop[k + 1]].map((v) => entity.vertices[v as number] as Vec3) as [Vec3, Vec3, Vec3];
      const t = rayTriangle(ray, a, b, c);
      if (t !== null && (face === null || t < face.distance))
        face = { id: entity.elementIds.faces[index] as string, index, distance: t, point: add3(ray.origin, scale3(ray.direction, t)) };
    }
  });
  let vertex: CagePick['vertex'] = null;
  entity.vertices.forEach((q, index) => {
    const { distance, t } = rayDistanceToPoint(ray, q);
    if (distance <= tolerance && (vertex === null || distance < vertex.distance))
      vertex = { id: entity.elementIds.vertices[index] as string, index, distance, t };
  });
  let edge: CagePick['edge'] = null;
  topology.edges.forEach(({ a, b }, index) => {
    const { distance, t } = rayDistanceToSegment(ray, entity.vertices[a] as Vec3, entity.vertices[b] as Vec3);
    if (distance <= tolerance && (edge === null || distance < edge.distance))
      edge = { id: edgeIdOf(entity.elementIds, a, b), index, a, b, distance, t };
  });
  return { face, vertex, edge };
}

/** A world-space ray as an entity-local ray (the entity is placed by `position` and XYZ Euler `rotation`). */
export function localRay(entity: Pick<SubdivisionEntity, 'position' | 'rotation'>, ray: Ray): Ray {
  return {
    origin: inverseEulerXYZ(sub3(ray.origin, entity.position), entity.rotation),
    direction: inverseEulerXYZ(ray.direction, entity.rotation),
  };
}
