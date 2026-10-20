/**
 * Blend patch between two patch edges (02 SRF M7): across the gap every station is a Bezier segment from the edge point of A to its foot point on
 * the edge of B, with end tangents in the tangent planes (G1: cubic) and end normal curvatures along the cross direction (G2: quintic); the
 * stations are interpolated along the edge (shared uniform parameters, so every row of poles has the same knots).
 */

import type { Vec3 } from '../../model/vectors';
import { add3, distance3, dot3, len3, scale3, sub3 } from '../vec3';
import { closestOnCurve } from './closest';
import { crossFrameAt, sideEdge, type CrossFrame, type PatchSide } from './crossFrame';
import { interpolatePoints } from './interpolate';
import type { NurbsSurfaceData } from './surfaceTypes';
import type { NurbsCurveData } from './types';

export interface BlendRequest {
  readonly a: NurbsSurfaceData;
  readonly sideA: PatchSide;
  readonly b: NurbsSurfaceData;
  readonly sideB: PatchSide;
  readonly continuity: 'G1' | 'G2';
  /** End tangent length as a fraction of the gap between the edges (1 = the gap). */
  readonly factor: number;
  /** Stations along the edge (>= 5). */
  readonly stations: number;
}

export type BlendResult =
  | { readonly surface: NurbsSurfaceData; readonly meanGap: number; readonly maxGap: number }
  | { readonly code: 'SRF_BLEND_DEGENERATE' | 'SRF_BLEND_FOLD'; readonly message: string };

const fail = (code: 'SRF_BLEND_DEGENERATE' | 'SRF_BLEND_FOLD', message: string): BlendResult => ({ code, message });

/** The across poles of one station (4 for G1, 6 for G2) from edge point A to edge point B. */
function stationPoles(fa: CrossFrame, fb: CrossFrame, continuity: 'G1' | 'G2', factor: number): Vec3[] {
  const length = distance3(fa.point, fb.point);
  const [t0, t1] = [scale3(fa.across, factor * length), scale3(fb.across, factor * length)];
  if (continuity === 'G1') return [fa.point, add3(fa.point, scale3(t0, 1 / 3)), add3(fb.point, scale3(t1, 1 / 3)), fb.point];
  const p1 = add3(fa.point, scale3(t0, 1 / 5));
  const p4 = add3(fb.point, scale3(t1, 1 / 5));
  const c0 = scale3(fa.normal, fa.curvature * len3(t0) ** 2);
  const c1 = scale3(fb.normal, fb.curvature * len3(t1) ** 2);
  const p2 = add3(sub3(scale3(p1, 2), fa.point), scale3(c0, 1 / 20));
  const p3 = add3(sub3(scale3(p4, 2), fb.point), scale3(c1, 1 / 20));
  return [fa.point, p1, p2, p3, p4, fb.point];
}

/** The blend surface (u along the edges, v from A at v = 0 to B at v = 1), or why it cannot be built. */
export function buildBlend(request: BlendRequest): BlendResult {
  const { a, sideA, b, sideB, continuity, factor, stations } = request;
  const [edgeA, edgeB] = [sideEdge(a, sideA), sideEdge(b, sideB)];
  const rows: Vec3[][] = [];
  let [sum, worst] = [0, 0];
  for (let i = 0; i < stations; i++) {
    const tA = edgeA.interval[0] + ((edgeA.interval[1] - edgeA.interval[0]) * i) / (stations - 1);
    const fa = crossFrameAt(a, sideA, tA);
    if (fa.degenerate)
      return fail('SRF_BLEND_DEGENERATE', `surface A is singular on its edge at parameter ${tA.toFixed(4)} (a pole or collapsed edge)`);
    const foot = closestOnCurve(edgeB.curve, fa.point);
    const fb = crossFrameAt(b, sideB, foot.t);
    if (fb.degenerate) return fail('SRF_BLEND_DEGENERATE', `surface B is singular on its edge at parameter ${foot.t.toFixed(4)}`);
    const gap = foot.distance;
    if (!(gap > 1e-9 * Math.max(1, len3(fa.point))))
      return fail('SRF_BLEND_DEGENERATE', 'the two edges touch: there is no gap to blend (use check_continuity)');
    const toB = sub3(fb.point, fa.point);
    if (!(dot3(fa.across, toB) > 0) || !(dot3(fb.across, scale3(toB, -1)) > 0))
      return fail(
        'SRF_BLEND_FOLD',
        `at station ${i} an edge leaves its surface away from the other edge: the sheets face away from each other`,
      );
    sum += gap;
    worst = Math.max(worst, gap);
    rows.push(stationPoles(fa, fb, continuity, factor));
  }
  const degreeV = continuity === 'G1' ? 3 : 5;
  const degreeU = Math.min(3, stations - 1);
  const curves: NurbsCurveData[] = [];
  for (let k = 0; k <= degreeV; k++) {
    const through = interpolatePoints(
      rows.map((row) => row[k] as Vec3),
      { degree: degreeU, parameterization: 'uniform' },
    );
    if ('code' in through) return fail('SRF_BLEND_DEGENERATE', through.message);
    curves.push(through.curve);
  }
  const first = curves[0] as NurbsCurveData;
  const surface: NurbsSurfaceData = {
    degreeU,
    degreeV,
    poles: rows.map((_, i) => curves.map((curve) => curve.poles[i] as Vec3)),
    knotsU: first.knots,
    multiplicitiesU: first.multiplicities,
    knotsV: [0, 1],
    multiplicitiesV: [degreeV + 1, degreeV + 1],
  };
  return { surface, meanGap: sum / stations, maxGap: worst };
}
