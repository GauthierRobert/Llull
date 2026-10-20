/**
 * Trim loops of a sheet from a trimming curve chain (02 SRF): the curve is projected into the (u, v) plane, a closed chain becomes a loop (kept
 * inside, or kept outside as a hole in the domain rectangle), an open chain that crosses the domain from boundary to boundary cuts the
 * rectangle in two and the side holding the keep point is kept.
 */

import type { Vec3 } from '../../model/vectors';
import { pointInPolygon, segmentsIntersect, selfIntersects } from '../polygon';
import { closestOnSurface } from './closest';
import { curveDomain, evaluateCurve } from './evaluate';
import { curveProjector, type ProjectedPoint, type Uv } from './projectCurve';
import { surfaceDomain } from './surface';
import type { NurbsSurfaceData, UvTrimLoop } from './surfaceTypes';
import type { NurbsCurveData } from './types';
import { domainLoop, insideRegion, loopsCross } from './trimRegion';

type TrimFailureCode = 'SRF_TRIM_MISS' | 'SRF_TRIM_AMBIGUOUS' | 'SRF_TRIM_LOOP_INVALID' | 'SRF_TRIM_UNSUPPORTED';

export type TrimBuild =
  | { readonly loops: UvTrimLoop[]; readonly note: string; readonly maxGap: number; readonly vertices: number }
  | { readonly code: TrimFailureCode; readonly message: string };

export interface TrimRequest {
  readonly surface: NurbsSurfaceData;
  /** The trimming curves chained end to end and oriented along the chain (world coordinates). */
  readonly chain: ReadonlyArray<NurbsCurveData>;
  readonly closed: boolean;
  /** Carry the curve along this direction onto the surface; null = closest-point projection. */
  readonly direction: Vec3 | null;
  readonly keep: 'inside' | 'outside';
  readonly keepPoint: Vec3 | null;
  readonly existing: ReadonlyArray<UvTrimLoop> | undefined;
  readonly hitTolerance: number;
}

/** About this many vertices per loop (each knot span is cut into an even number of equal parts). */
const TARGET_VERTICES = 512;

const fail = (code: TrimFailureCode, message: string): TrimBuild => ({ code, message });
const midpoint = (a: Uv, b: Uv): Uv => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
const asPoint = (uv: Uv): [number, number] => [uv[0], uv[1]];

/** Chain parameter tau in [0, chain.length]: curve k covers [k, k + 1], mapped affinely onto its own domain. */
function chainPoint(chain: ReadonlyArray<NurbsCurveData>): (tau: number) => Vec3 {
  return (tau) => {
    const k = Math.min(chain.length - 1, Math.max(0, Math.floor(tau)));
    const curve = chain[k] as NurbsCurveData;
    const [a, b] = curveDomain(curve);
    return evaluateCurve(curve, a + (b - a) * (tau - k));
  };
}

/** Chain parameters of the samples: every knot span of every curve cut into the same even number of parts, so the count of intervals is even. */
function chainParameters(chain: ReadonlyArray<NurbsCurveData>): number[] {
  const spans = chain.reduce((sum, curve) => sum + curve.knots.length - 1, 0);
  const parts = Math.max(2, 2 * Math.ceil(TARGET_VERTICES / 2 / spans));
  const taus: number[] = [];
  chain.forEach((curve, k) => {
    const [first, last] = [curve.knots[0] as number, curve.knots[curve.knots.length - 1] as number];
    for (let j = 0; j + 1 < curve.knots.length; j++) {
      const [f0, f1] = [((curve.knots[j] as number) - first) / (last - first), ((curve.knots[j + 1] as number) - first) / (last - first)];
      for (let s = 0; s < parts; s++) taus.push(k + f0 + ((f1 - f0) * s) / parts);
    }
  });
  taus.push(chain.length);
  return taus;
}

/** Position of a boundary point along the perimeter of the rectangle, counter-clockwise from the lower left corner. */
function perimeterPosition(surface: NurbsSurfaceData, [u, v]: Uv): number {
  const [[u0, u1], [v0, v1]] = surfaceDomain(surface);
  const [w, h] = [u1 - u0, v1 - v0];
  const edges = [
    { distance: Math.abs(v - v0), position: u - u0 },
    { distance: Math.abs(u - u1), position: w + (v - v0) },
    { distance: Math.abs(v - v1), position: w + h + (u1 - u) },
    { distance: Math.abs(u - u0), position: 2 * w + h + (v1 - v) },
  ];
  return edges.reduce((best, edge) => (edge.distance < best.distance ? edge : best)).position % (2 * (w + h));
}

/** The rectangle corners strictly between two perimeter positions travelling counter-clockwise (`ccw`) or clockwise, in travel order. */
function cornersBetween(surface: NurbsSurfaceData, from: number, to: number, ccw: boolean): Uv[] {
  const [[u0, u1], [v0, v1]] = surfaceDomain(surface);
  const [w, h] = [u1 - u0, v1 - v0];
  const total = 2 * (w + h);
  const corners: Array<{ position: number; uv: Uv }> = [
    { position: 0, uv: [u0, v0] },
    { position: w, uv: [u1, v0] },
    { position: w + h, uv: [u1, v1] },
    { position: 2 * w + h, uv: [u0, v1] },
  ];
  const travelled = (position: number): number => (((ccw ? position - from : from - position) % total) + total) % total;
  const span = travelled(to) || total;
  return corners
    .map((corner) => ({ ...corner, along: travelled(corner.position) }))
    .filter((corner) => corner.along > 1e-12 && corner.along < span - 1e-12)
    .sort((a, b) => a.along - b.along)
    .map((corner) => corner.uv);
}

/** The cut region on one side of an open curve: the curve vertices, then the boundary walk back to its start (corners at even indices). */
function cutRegion(surface: NurbsSurfaceData, curve: ReadonlyArray<Uv>, ccw: boolean): UvTrimLoop {
  const first = curve[0] as Uv;
  const last = curve[curve.length - 1] as Uv;
  const corners = cornersBetween(surface, perimeterPosition(surface, last), perimeterPosition(surface, first), ccw);
  const path: Uv[] = [last, ...corners, first];
  const tail: Uv[] = [];
  for (let i = 1; i < path.length; i++) {
    tail.push(midpoint(path[i - 1] as Uv, path[i] as Uv));
    if (i + 1 < path.length) tail.push(path[i] as Uv);
  }
  return { outer: true, polygon: [...curve, ...tail] };
}

/** Bisection of the chain parameter between a boundary sample and an interior sample: the boundary crossing of the projected curve. */
function crossingPoint(
  project: (tau: number, seed?: Uv) => ProjectedPoint | null,
  boundary: { tau: number; uv: Uv },
  interior: { tau: number; uv: Uv },
): Uv | null {
  let [outside, inside] = [boundary.tau, interior.tau];
  for (let step = 0; step < 48; step++) {
    const mid = (outside + inside) / 2;
    const hit = project(mid, step === 0 ? interior.uv : undefined);
    if (hit === null) return null;
    if (hit.onBoundary) outside = mid;
    else inside = mid;
  }
  return project(outside)?.uv ?? null;
}

/** True when two non-adjacent segments of the open polyline cross. */
function polylineCrosses(points: ReadonlyArray<Uv>): boolean {
  for (let i = 0; i + 1 < points.length; i++)
    for (let j = i + 2; j + 1 < points.length; j++)
      if (segmentsIntersect(asPoint(points[i] as Uv), asPoint(points[i + 1] as Uv), asPoint(points[j] as Uv), asPoint(points[j + 1] as Uv)))
        return true;
  return false;
}

/** Adds a hole to a sheet that already has trims: only a hole strictly inside the current region, crossing and containing none of its loops. */
function addHole(existing: ReadonlyArray<UvTrimLoop>, hole: UvTrimLoop): TrimBuild {
  const probe = hole.polygon[0] as Uv;
  if (!insideRegion(existing, probe) || existing.some((loop) => loopsCross(loop.polygon, hole.polygon)))
    return fail(
      'SRF_TRIM_UNSUPPORTED',
      'the sheet is already trimmed: a further curve is only supported as a hole wholly inside the kept region',
    );
  const holePolygon = hole.polygon.map(asPoint);
  if (existing.some((loop) => !loop.outer && pointInPolygon(asPoint(loop.polygon[0] as Uv), holePolygon)))
    return fail('SRF_TRIM_UNSUPPORTED', 'the new hole would contain an existing hole');
  return { loops: [...existing, hole], note: 'hole added to the existing trims', maxGap: 0, vertices: hole.polygon.length };
}

/** The trim loops of `request`, or the reason the curve cannot trim the sheet. */
export function buildTrimLoops(request: TrimRequest): TrimBuild {
  const { surface, chain, closed, direction, keepPoint, existing } = request;
  const taus = chainParameters(chain);
  const projector = curveProjector(surface, chainPoint(chain), direction, request.hitTolerance);
  const samples: ProjectedPoint[] = [];
  for (const tau of taus) {
    const hit = projector.project(tau);
    if (hit === null)
      return fail('SRF_TRIM_MISS', `the line along projectAlong through the curve at parameter ${tau.toFixed(3)} does not hit the sheet`);
    samples.push(hit);
  }
  const maxGap = Math.max(...samples.map((sample) => sample.gap));
  const keepUv = keepPoint === null ? null : ((found) => [found.u, found.v] as const)(closestOnSurface(surface, keepPoint));
  const intervals = samples.length - 1;
  if (closed) {
    if (samples.some((sample) => sample.onBoundary))
      return fail(
        'SRF_TRIM_MISS',
        'the closed trimming curve reaches the boundary of the sheet: shrink it, or cut with an open curve that crosses the sheet',
      );
    const polygon = samples.slice(0, intervals).map((sample) => sample.uv);
    if (selfIntersects(polygon.map(asPoint))) return fail('SRF_TRIM_LOOP_INVALID', 'the projected trimming curve crosses itself');
    const inside = keepUv === null ? request.keep === 'inside' : pointInPolygon(asPoint(keepUv), polygon.map(asPoint));
    const loop: UvTrimLoop = { outer: inside, polygon };
    if (existing !== undefined && existing.length > 0)
      return inside
        ? fail('SRF_TRIM_UNSUPPORTED', 'the sheet is already trimmed: keep "outside" to add a hole')
        : addHole(existing, { outer: false, polygon });
    return {
      loops: inside ? [loop] : [domainLoop(surface), { outer: false, polygon }],
      note: `closed loop of ${polygon.length} vertices, kept ${inside ? 'inside' : 'outside'}`,
      maxGap,
      vertices: polygon.length,
    };
  }
  const interior = samples.map((sample, index) => (sample.onBoundary ? -1 : index)).filter((index) => index >= 0);
  const [a, b] = [interior[0], interior[interior.length - 1]];
  if (a === undefined || b === undefined) return fail('SRF_TRIM_MISS', 'the trimming curve does not enter the interior of the sheet');
  if (a === 0 || b === intervals)
    return fail(
      'SRF_TRIM_LOOP_INVALID',
      'an open trimming curve must run from the boundary of the sheet to the boundary (extend it past the edges)',
    );
  if (samples.slice(a, b + 1).some((sample) => sample.onBoundary))
    return fail('SRF_TRIM_UNSUPPORTED', 'the trimming curve leaves the sheet and re-enters it: split it into one curve per crossing');
  const at = (index: number): { tau: number; uv: Uv } => ({ tau: taus[index] as number, uv: (samples[index] as ProjectedPoint).uv });
  const start = crossingPoint(projector.project, at(a - 1), at(a));
  const end = crossingPoint(projector.project, at(b + 1), at(b));
  if (start === null || end === null)
    return fail('SRF_TRIM_MISS', 'cannot locate where the trimming curve crosses the boundary of the sheet');
  const run = samples.slice(a, b + 1).map((sample) => sample.uv);
  const cut: Uv[] = [start, ...run, ...(run.length % 2 === 1 ? [] : [midpoint(run[run.length - 1] as Uv, end)]), end];
  if (polylineCrosses(cut)) return fail('SRF_TRIM_LOOP_INVALID', 'the projected trimming curve crosses itself');
  if (keepUv === null)
    return fail('SRF_TRIM_AMBIGUOUS', 'an open trimming curve cuts the sheet in two: give keepPoint, a point on the side to keep');
  if (existing !== undefined && existing.length > 0)
    return fail('SRF_TRIM_UNSUPPORTED', 'the sheet is already trimmed: a cut by an open curve is only supported on an untrimmed sheet');
  const sides = [cutRegion(surface, cut, true), cutRegion(surface, cut, false)];
  const kept = sides.find((side) => pointInPolygon(asPoint(keepUv), side.polygon.map(asPoint)));
  if (kept === undefined) return fail('SRF_TRIM_AMBIGUOUS', 'keepPoint lies on the trimming curve: move it to one side');
  return { loops: [kept], note: `open cut of ${cut.length} vertices`, maxGap, vertices: kept.polygon.length };
}
