/**
 * Closed-form volume change of an emboss / deboss on a plane, cylinder, cone, sphere or torus face (03 WRP, TECHNICAL_SPEC §5.3): a normal offset by t scales the face area
 * by 1 + t k (k = the circumferential curvature, 0 on a plane), so a region of area A lifted by d adds A d + k-integral d^2 / 2:
 *   plane A d · cylinder A d (1 ± d / 2r) · cone A d ± (d^2 / 2) cos(alpha) A_uv   (+ for material outside a convex face, - for a deboss; signs flip on a bore)
 *   sphere A (e + e^2 / R + e^3 / 3 R^2) · torus R (r e + e^2 / 2) A_uv + ((r + e)^3 - r^3) / 3 B   with e the signed offset along the surface normal and B = the integral of cos v over the region.
 * @invariant computed from the stored recipe only, independent of the kernel's mass integration, so it can check it (check_wrap)
 */

import type { Vec2, Vec3 } from '../model/vectors';
import { integrateCurve } from '../lib/nurbs/integrate';
import { curveDomain } from '../lib/nurbs/evaluate';
import { dot3, cross3, normalize3, scale3, add3 } from '../lib/vec3';
import type { NurbsCurveData } from '../lib/nurbs/types';
import type { EmbossParams, UvLoop } from '../model/wrap';
import { integrateDu } from './uvIntegrals';

export interface UvAreas {
  /** Area of the loop in the (u, v) plane (absolute). */
  readonly uv: number;
  /** Integral of v over the loop's (u, v) area, the cone's weight (area on the cone = sin(alpha) x this). */
  readonly vWeighted: number;
}

const lift = (curve: {
  poles: ReadonlyArray<Vec2>;
  weights?: ReadonlyArray<number>;
  degree: number;
  knots: ReadonlyArray<number>;
  multiplicities: ReadonlyArray<number>;
}): NurbsCurveData => ({ ...curve, poles: curve.poles.map(([x, y]): Vec3 => [x, y, 0]) });

/** Signed (u, v) area and the contour integral of v^2 / 2 du (= minus the integral of v over a counter-clockwise loop), by Green's theorem over the loop segments. */
function loopIntegrals(loop: UvLoop): { area: number; vArea: number } {
  let area = 0;
  let vArea = 0;
  let at = loop.start;
  for (const segment of loop.segments) {
    if (segment.kind === 'line') {
      const [u1, v1] = at;
      const [u2, v2] = segment.to;
      area += (u1 * v2 - u2 * v1) / 2;
      vArea += ((u2 - u1) * (v1 * v1 + v1 * v2 + v2 * v2)) / 6;
      at = segment.to;
    } else {
      const curve = lift(segment.curve);
      const [first, last] = curveDomain(curve);
      area += integrateCurve(curve, first, last, (point, derivative) => (point[0] * derivative[1] - point[1] * derivative[0]) / 2);
      vArea += integrateCurve(curve, first, last, (point, derivative) => (point[1] * point[1] * derivative[0]) / 2);
      at = segment.curve.poles[segment.curve.poles.length - 1] as Vec2;
    }
  }
  return { area, vArea };
}

/** Area and v-weighted area of the regions (outer loops minus holes), absolute orientation. */
export function regionsAreas(regions: EmbossParams['regions']): UvAreas {
  let uv = 0;
  let vWeighted = 0;
  for (const region of regions) {
    const outer = loopIntegrals(region.outer);
    const sign = Math.sign(outer.area) || 1;
    uv += Math.abs(outer.area);
    vWeighted -= sign * outer.vArea;
    for (const hole of region.holes) {
      const inner = loopIntegrals(hole);
      const holeSign = Math.sign(inner.area) || 1;
      uv -= Math.abs(inner.area);
      vWeighted += holeSign * inner.vArea;
    }
  }
  return { uv, vWeighted };
}

export interface EmbossClosedForm {
  /** Area of the regions on the face (document units squared). */
  readonly area: number;
  /** Volume change of the solid (negative for a deboss), document units cubed. */
  readonly delta: number;
  /** Material lies inside the face (convex: pin, boss, cone) as opposed to outside it (a bore). */
  readonly convex: boolean | null;
}

/** The closed form of a node, or null for a scribe-only node's volume (0 is returned) / an unreadable surface. */
/** Integral over the regions of the area element F'(v) du dv, F given: minus the loop integral of F du, orientation-corrected (holes subtract). */
function regionQuantity(regions: EmbossParams['regions'], antiderivative: (v: number) => number): number {
  const loopQuantity = (loop: UvLoop): number => -(Math.sign(loopIntegrals(loop).area) || 1) * integrateDu(loop, antiderivative);
  return regions.reduce(
    (total, region) => total + loopQuantity(region.outer) - region.holes.reduce((sum, hole) => sum + loopQuantity(hole), 0),
    0,
  );
}

/** Unit normal Su x Sv of a sphere or torus wire at (u, v): outward from the sphere / the tube. */
function curvedNormal(data: readonly number[], [u, v]: Vec2): Vec3 {
  const axis = normalize3([data[3] as number, data[4] as number, data[5] as number]);
  const x = normalize3([data[6] as number, data[7] as number, data[8] as number]);
  const radial = add3(scale3(x, Math.cos(u)), scale3(cross3(axis, x), Math.sin(u)));
  return add3(scale3(radial, Math.cos(v)), scale3(axis, Math.sin(v)));
}

export function embossClosedForm(
  node: Pick<EmbossParams, 'surface' | 'regions' | 'mode' | 'depth' | 'direction'>,
): EmbossClosedForm | null {
  const { type, data } = node.surface;
  const { uv, vWeighted } = regionsAreas(node.regions);
  const d = node.depth;
  const firstLoop = node.regions[0]?.outer;
  if (firstLoop === undefined) return null;
  const sign = node.mode === 'deboss' ? -1 : 1;
  const volume = (delta: number): number => (node.mode === 'scribe' ? 0 : delta);
  const point = (index: number): Vec3 => [data[index] as number, data[index + 1] as number, data[index + 2] as number];
  if (type === 'plane') return { area: uv, delta: volume(sign * uv * d), convex: null };
  if (type === 'cylinder') {
    const axis = normalize3(point(3));
    const x = normalize3(point(6));
    const y = cross3(axis, x);
    const radius = data[9] as number;
    const u = firstLoop.start[0];
    const radial = add3(scale3(x, Math.cos(u)), scale3(y, Math.sin(u)));
    const convex = dot3(node.direction, radial) > 0;
    const area = uv * radius;
    return { area, delta: volume(sign * (area * d + (convex ? 1 : -1) * sign * area * ((d * d) / (2 * radius)))), convex };
  }
  if (type === 'cone') {
    const axis = normalize3(point(3));
    const x = normalize3(point(6));
    const y = cross3(axis, x);
    const alpha = data[9] as number;
    const u = firstLoop.start[0];
    const radial = add3(scale3(x, Math.cos(u)), scale3(y, Math.sin(u)));
    const normal = add3(scale3(radial, Math.cos(alpha)), scale3(axis, -Math.sin(alpha)));
    const convex = dot3(node.direction, normal) > 0;
    const area = Math.sin(alpha) * vWeighted;
    return { area, delta: volume(sign * (area * d + (convex ? 1 : -1) * sign * (d * d * 0.5) * Math.cos(alpha) * uv)), convex };
  }
  if ((type === 'sphere' && data.length === 10) || (type === 'torus' && data.length === 11)) {
    const radius = type === 'sphere' ? (data[9] as number) : (data[10] as number);
    const major = type === 'torus' ? (data[9] as number) : 0;
    const cosInt = regionQuantity(node.regions, Math.sin);
    const convex = dot3(node.direction, curvedNormal(data, firstLoop.start)) > 0;
    const area = type === 'sphere' ? radius * radius * cosInt : radius * (major * uv + radius * cosInt);
    const offsetVolume = (e: number): number =>
      type === 'sphere'
        ? area * (e + (e * e) / radius + (e * e * e) / (3 * radius * radius))
        : major * (radius * e + (e * e) / 2) * uv + (((radius + e) ** 3 - radius ** 3) / 3) * cosInt;
    const reach = (node.mode === 'deboss' ? -1 : 1) * (convex ? 1 : -1) * d;
    return { area, delta: volume(sign * Math.abs(offsetVolume(reach))), convex };
  }
  return null;
}
