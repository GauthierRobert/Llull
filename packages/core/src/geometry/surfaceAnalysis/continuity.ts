/**
 * Geometric continuity of a joint (G0 position, G1 tangent / normal, G2 curvature, G3 curvature rate) between two curves or along the
 * shared boundary edge of two patches. Everything is measured on the exact NURBS: derivatives by the quotient rule, foot points by Newton.
 */

import type { Vec3 } from '../../model/vectors';
import { cross3, distance3, dot3, len3, scale3, sub3 } from '../../lib/vec3';
import { curvatureAt, planeNormalOf, type CurvatureSample } from '../../lib/nurbs/curvature';
import { closestOnCurve } from '../../lib/nurbs/closest';
import { curveDomain, evaluateCurve } from '../../lib/nurbs/evaluate';
import { isoCurve, surfaceDomain } from '../../lib/nurbs/surface';
import { normalCurvature, surfaceSample } from '../../lib/nurbs/surfaceCurvature';
import type { NurbsCurveData } from '../../lib/nurbs/types';
import type { NurbsSurfaceData } from '../../lib/nurbs/surfaceTypes';
import type { ContinuityEdge, ContinuityJoint, ContinuityOrder, ContinuitySample, ContinuityTolerances, SurfaceSide } from './types';

const clampUnit = (value: number): number => Math.max(-1, Math.min(1, value));

/** The curve of a patch side (u0 / u1: constant u, a curve in v; v0 / v1: constant v, a curve in u) and its constant parameter pair. */
function sideCurve(surface: NurbsSurfaceData, side: SurfaceSide): { curve: NurbsCurveData; at: (t: number) => readonly [number, number] } {
  const [[uMin, uMax], [vMin, vMax]] = surfaceDomain(surface);
  switch (side) {
    case 'u0':
      return { curve: isoCurve(surface, 'u', uMin), at: (t) => [uMin, t] };
    case 'u1':
      return { curve: isoCurve(surface, 'u', uMax), at: (t) => [uMax, t] };
    case 'v0':
      return { curve: isoCurve(surface, 'v', vMin), at: (t) => [t, vMin] };
    case 'v1':
      return { curve: isoCurve(surface, 'v', vMax), at: (t) => [t, vMax] };
  }
}

const orderOf = (g0: boolean, g1: boolean, g2: boolean, g3: boolean): ContinuityOrder =>
  !g0 ? 'none' : !g1 ? 'G0' : !g2 ? 'G1' : !g3 ? 'G2' : 'G3';

const relativeJump = (a: number, b: number, floor: number): number => {
  const scale = Math.max(Math.abs(a), Math.abs(b));
  return scale <= floor ? 0 : Math.abs(a - b) / scale;
};

/** Joint of two curves: the nearest pair of ends is compared (positions, tangents, curvature vectors, curvature rates in the travel direction). */
function curveJoint(a: NurbsCurveData, b: NurbsCurveData, tol: ContinuityTolerances): ContinuityJoint {
  const [[a0, a1], [b0, b1]] = [curveDomain(a), curveDomain(b)];
  const ends = [
    { atEnd: false, u: a0, pointA: evaluateCurve(a, a0) },
    { atEnd: true, u: a1, pointA: evaluateCurve(a, a1) },
  ];
  let best: { endA: (typeof ends)[number]; startB: boolean; uB: number; gap: number } | null = null;
  for (const endA of ends)
    for (const [startB, uB] of [
      [true, b0],
      [false, b1],
    ] as const) {
      const gap = distance3(endA.pointA, evaluateCurve(b, uB));
      if (best === null || gap < best.gap) best = { endA, startB, uB, gap };
    }
  const { endA, startB, uB } = best as NonNullable<typeof best>;
  const [normalA, normalB] = [planeNormalOf(a), planeNormalOf(b)];
  const parallel = normalA !== null && normalB !== null && len3(cross3(normalA, normalB)) < 1e-9;
  const planeNormal = parallel || normalB === null ? normalA : normalA === null ? normalB : null;
  const [sa, sb]: [CurvatureSample, CurvatureSample] = [curvatureAt(a, endA.u, planeNormal), curvatureAt(b, uB, planeNormal)];
  const [outA, inB] = [scale3(sa.tangent, endA.atEnd ? 1 : -1), scale3(sb.tangent, startB ? 1 : -1)];
  const g0Gap = distance3(sa.point, sb.point);
  const g1 = Math.acos(clampUnit(dot3(outA, inB)));
  const [kA, kB] = [scale3(sa.normal, sa.curvature), scale3(sb.normal, sb.curvature)];
  const g2Gap = len3(sub3(kA, kB));
  const g2Rel = relativeJump(sa.curvature, sb.curvature, tol.g2Abs);
  const rate = (sample: CurvatureSample, forward: boolean): number =>
    planeNormal !== null || forward ? sample.dCurvatureDs : -sample.dCurvatureDs;
  const [rateA, rateB] = [rate(sa, endA.atEnd), rate(sb, startB)];
  const g3Gap = Math.abs(rateA - rateB);
  const g0 = g0Gap <= tol.g0;
  const g1ok = g1 <= tol.g1AngleRad;
  const g2ok = g2Gap <= tol.g2Abs || g2Gap / Math.max(sa.curvature, sb.curvature) <= tol.g2Rel;
  const g3ok = g3Gap <= tol.g2Abs || g3Gap <= tol.g3Rel * Math.max(Math.abs(rateA), Math.abs(rateB));
  const t = endA.atEnd ? 1 : 0;
  const sample: ContinuitySample = { t, point: sa.point, g0Gap, g1AngleRad: g1, g2Gap, g3Gap };
  return {
    samples: [sample],
    g0Gap,
    g1AngleRad: g1,
    g2Gap,
    g2Rel,
    g3Gap,
    order: orderOf(g0, g1ok, g2ok, g3ok),
    worst: { t, point: sa.point },
  };
}

/** Joint of two patches along side `sideA` of `a` and side `sideB` of `b`, sampled `count` times along `a`'s edge. */
function surfaceJoint(
  a: NurbsSurfaceData,
  sideA: SurfaceSide,
  b: NurbsSurfaceData,
  sideB: SurfaceSide,
  count: number,
  tol: ContinuityTolerances,
): ContinuityJoint {
  const [edgeA, edgeB] = [sideCurve(a, sideA), sideCurve(b, sideB)];
  const [first, last] = curveDomain(edgeA.curve);
  const samples: ContinuitySample[] = [];
  let [g0Max, g1Max, g2Max, g2RelMax] = [0, 0, 0, 0];
  let g2All = true;
  let worst: { t: number; point: Vec3; score: number } = { t: 0, point: evaluateCurve(edgeA.curve, first), score: -1 };
  const crossA = sideA.startsWith('u') ? ([1, 0] as const) : ([0, 1] as const);
  const crossB = sideB.startsWith('u') ? ([1, 0] as const) : ([0, 1] as const);
  for (let i = 0; i < count; i++) {
    const t = i / (count - 1);
    const [uA, vA] = edgeA.at(first + (last - first) * t);
    const sampleA = surfaceSample(a, uA, vA);
    const foot = closestOnCurve(edgeB.curve, sampleA.point);
    const [uB, vB] = edgeB.at(foot.t);
    const sampleB = surfaceSample(b, uB, vB);
    if (sampleA.degenerate || sampleB.degenerate) continue;
    const g0Gap = distance3(sampleA.point, sampleB.point);
    const alignment = dot3(sampleA.normal, sampleB.normal);
    const g1 = Math.acos(clampUnit(Math.abs(alignment)));
    const sign = alignment < 0 ? -1 : 1;
    const kA = normalCurvature(sampleA, crossA[0], crossA[1]);
    const kB = sign * normalCurvature(sampleB, crossB[0], crossB[1]);
    const g2Gap = Math.abs(kA - kB);
    const g2Rel = relativeJump(kA, kB, tol.g2Abs);
    const g2Fine = g2Gap <= tol.g2Abs || g2Rel <= tol.g2Rel;
    g2All = g2All && g2Fine;
    samples.push({ t, point: sampleA.point, g0Gap, g1AngleRad: g1, g2Gap, g3Gap: null });
    [g0Max, g1Max, g2Max, g2RelMax] = [Math.max(g0Max, g0Gap), Math.max(g1Max, g1), Math.max(g2Max, g2Gap), Math.max(g2RelMax, g2Rel)];
    const score = Math.max(g0Gap / tol.g0, g1 / tol.g1AngleRad, g2Fine ? 0 : g2Rel / tol.g2Rel);
    if (score > worst.score) worst = { t, point: sampleA.point, score };
  }
  const order = samples.length === 0 ? 'none' : orderOf(g0Max <= tol.g0, g1Max <= tol.g1AngleRad, g2All, false);
  return {
    samples,
    g0Gap: g0Max,
    g1AngleRad: g1Max,
    g2Gap: g2Max,
    g2Rel: g2RelMax,
    g3Gap: null,
    order: order === 'G3' ? 'G2' : order,
    worst: { t: worst.t, point: worst.point },
  };
}

/**
 * Continuity of the joint between two edges of the same kind (curve + curve, or patch side + patch side); a mixed pair reports no joint.
 * @invariant the order is the highest G-level whose measures are all within tolerance (surfaces stop at G2; third order is not measured)
 */
export function analyzeContinuity(
  a: ContinuityEdge,
  b: ContinuityEdge,
  samples: number,
  tolerances: ContinuityTolerances,
): ContinuityJoint {
  if (a.type === 'curve' && b.type === 'curve') return curveJoint(a.curve, b.curve, tolerances);
  if (a.type === 'surface' && b.type === 'surface')
    return surfaceJoint(a.surface, a.side, b.surface, b.side, Math.max(2, samples), tolerances);
  return {
    samples: [],
    g0Gap: Infinity,
    g1AngleRad: Infinity,
    g2Gap: Infinity,
    g2Rel: Infinity,
    g3Gap: null,
    order: 'none',
    worst: { t: 0, point: [0, 0, 0] },
  };
}
