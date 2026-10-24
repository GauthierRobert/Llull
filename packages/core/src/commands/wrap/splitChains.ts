/** Sampling helpers of `split_face_by_curves` (03 WRP): curve samples and continuous (u, v) across the seam of a periodic face. */

import type { Vec2, Vec3 } from '../../model/vectors';
import type { UvLoop } from '../../model/wrap';
import { curveDomain, evaluateCurve } from '../../lib/nurbs/evaluate';
import type { NurbsCurveData } from '../../lib/nurbs/types';

const TWO_PI = 2 * Math.PI;

/** `count` curve points at uniform parameters. */
export const curveSamples = (curve: NurbsCurveData, count: number): Vec3[] => {
  const [first, last] = curveDomain(curve);
  return Array.from({ length: count }, (_, k) => evaluateCurve(curve, first + ((last - first) * k) / (count - 1)));
};

/** (u, v) samples with the 2 pi jumps of a periodic axis removed, so a curve crossing the seam stays continuous. */
export function continuousUv(samples: readonly Vec2[], periodic: readonly [boolean, boolean]): Vec2[] {
  const out: Vec2[] = [];
  let shiftU = 0;
  let shiftV = 0;
  samples.forEach((uv, k) => {
    const previous = samples[k - 1];
    if (previous !== undefined) {
      if (periodic[0] && Math.abs(uv[0] - previous[0]) > Math.PI) shiftU -= Math.sign(uv[0] - previous[0]) * TWO_PI;
      if (periodic[1] && Math.abs(uv[1] - previous[1]) > Math.PI) shiftV -= Math.sign(uv[1] - previous[1]) * TWO_PI;
    }
    out.push([uv[0] + shiftU, uv[1] + shiftV]);
  });
  return out;
}

/**
 * The chains with their end points snapped together where they meet: the runs a closed sketch projects to (one curve per piece) share their joints exactly, so the
 * kernel splitter sees one closed boundary and not a ring with hairline gaps. Ends closer than `within` (face parameters) take their common mean.
 * @invariant every chain is a single clamped B-spline segment (first / last pole = its end points)
 */
export function snapChainEnds(chains: readonly UvLoop[], within: number): UvLoop[] {
  const ends: Array<{ chain: number; atStart: boolean; point: Vec2 }> = chains.flatMap((chain, index) => {
    const segment = chain.segments[0];
    if (segment === undefined || segment.kind !== 'nurbs') return [];
    const poles = segment.curve.poles;
    return [
      { chain: index, atStart: true, point: poles[0] as Vec2 },
      { chain: index, atStart: false, point: poles[poles.length - 1] as Vec2 },
    ];
  });
  const snapped = new Map<string, Vec2>();
  const key = (end: (typeof ends)[number]): string => `${end.chain}:${end.atStart}`;
  for (const end of ends) {
    if (snapped.has(key(end))) continue;
    const group = ends.filter((other) => Math.hypot(other.point[0] - end.point[0], other.point[1] - end.point[1]) < within);
    const mean: Vec2 = [
      group.reduce((sum, e) => sum + e.point[0], 0) / group.length,
      group.reduce((sum, e) => sum + e.point[1], 0) / group.length,
    ];
    for (const member of group) snapped.set(key(member), mean);
  }
  return chains.map((chain, index) => {
    const segment = chain.segments[0];
    if (segment === undefined || segment.kind !== 'nurbs') return chain;
    const poles = [...segment.curve.poles];
    poles[0] = snapped.get(`${index}:true`) ?? (poles[0] as Vec2);
    poles[poles.length - 1] = snapped.get(`${index}:false`) ?? (poles[poles.length - 1] as Vec2);
    return { start: poles[0] as Vec2, segments: [{ kind: 'nurbs', curve: { ...segment.curve, poles } }] };
  });
}
