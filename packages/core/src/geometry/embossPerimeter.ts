/**
 * Length on the face of the loops of an `emboss` node (03 WRP): the footprint's perimeter, from the node's own wire (the surface in the frame the loops are in). The exact kernel builds the
 * 3D edges of a fitted pcurve to within the node's tolerance, so a volume can differ from its closed form by about tolerance x perimeter x depth: `check_wrap` scales its guard with it.
 * @invariant pure; the polygon of 24 samples per curved piece is within 1e-4 of the true length for the smooth pieces the charts produce
 */

import type { Vec2, Vec3 } from '../model/vectors';
import type { EmbossParams, UvLoop } from '../model/wrap';
import { curveDomain } from '../lib/nurbs/evaluate';
import { pointAt2, type NurbsCurve2Data } from '../lib/nurbs/curve2d';
import { add3, cross3, normalize3, scale3 } from '../lib/vec3';

const SAMPLES = 24;

/** 3D point of (u, v) on the wire's surface, null for the wire form that has no frame (`face`). */
function pointOn(surface: EmbossParams['surface']): ((uv: Vec2) => Vec3) | null {
  const d = surface.data;
  const triple = (k: number): Vec3 => [d[k] as number, d[k + 1] as number, d[k + 2] as number];
  if (surface.type === 'plane') {
    const [origin, x, y] = [triple(0), triple(3), triple(6)];
    return ([u, v]) => add3(origin, add3(scale3(x, u), scale3(y, v)));
  }
  if (surface.type === 'face') return null;
  const [origin, axis, x] = [triple(0), normalize3(triple(3)), normalize3(triple(6))];
  const y = cross3(axis, x);
  const ring = (u: number): Vec3 => add3(scale3(x, Math.cos(u)), scale3(y, Math.sin(u)));
  if (surface.type === 'cylinder') {
    const radius = d[9] as number;
    return ([u, v]) => add3(add3(origin, scale3(axis, v)), scale3(ring(u), radius));
  }
  if (surface.type === 'cone') {
    const alpha = d[9] as number;
    return ([u, v]) => add3(origin, scale3(add3(scale3(axis, Math.cos(alpha)), scale3(ring(u), Math.sin(alpha))), v));
  }
  if (surface.type === 'sphere') {
    const radius = d[9] as number;
    return ([u, v]) => add3(origin, scale3(add3(scale3(ring(u), Math.cos(v)), scale3(axis, Math.sin(v))), radius));
  }
  const [major, minor] = [d[9] as number, d[10] as number];
  return ([u, v]) => add3(add3(origin, scale3(ring(u), major + minor * Math.cos(v))), scale3(axis, minor * Math.sin(v)));
}

function sampled(curve: NurbsCurve2Data): Vec2[] {
  const lifted = { ...curve, poles: curve.poles.map(([x, y]): Vec3 => [x, y, 0]) };
  const [first, last] = curveDomain(lifted);
  return Array.from({ length: SAMPLES + 1 }, (_, k) => pointAt2(curve, first + ((last - first) * k) / SAMPLES));
}

function loopLength(loop: UvLoop, point: (uv: Vec2) => Vec3): number {
  let at = loop.start;
  let total = 0;
  for (const segment of loop.segments) {
    const samples: Vec2[] =
      segment.kind === 'line'
        ? Array.from(
            { length: SAMPLES + 1 },
            (_, k): Vec2 => [at[0] + ((segment.to[0] - at[0]) * k) / SAMPLES, at[1] + ((segment.to[1] - at[1]) * k) / SAMPLES],
          )
        : sampled(segment.curve);
    for (let k = 1; k < samples.length; k++) {
      const [p, q] = [point(samples[k - 1] as Vec2), point(samples[k] as Vec2)];
      total += Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]);
    }
    at = samples[samples.length - 1] as Vec2;
  }
  return total;
}

/** Total length on the face of every loop (outer and holes) of the node's regions; null when the wire has no frame. */
export function footprintPerimeter(node: Pick<EmbossParams, 'surface' | 'regions'>): number | null {
  const point = pointOn(node.surface);
  if (point === null) return null;
  return node.regions.reduce(
    (sum, region) => sum + [region.outer, ...region.holes].reduce((inner, loop) => inner + loopLength(loop, point), 0),
    0,
  );
}
