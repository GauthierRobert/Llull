/**
 * Images of sketch curves on a face (03 WRP): the (u, v) pieces of a chart (exact under an affine chart, fitted for a cone), the single pcurve and the 3D
 * NURBS curve a `nurbs_curve` entity keeps, and their lengths on the face.
 * @invariant a plane keeps every piece exact; cylinder and cone 3D curves are cubic interpolants of the exact image whose deviation, measured between the
 *   interpolation points, stays within `tolerance`, and the measured deviation is reported, never hidden
 */

import type { Vec2, Vec3 } from '../model/vectors';
import { bezier2, pointAt2, type NurbsCurve2Data } from '../lib/nurbs/curve2d';
import { curveDomain, evaluateCurve } from '../lib/nurbs/evaluate';
import { interpolatePoints } from '../lib/nurbs/interpolate';
import { joinCurves } from '../lib/nurbs/joinCurves';
import type { NurbsCurveData } from '../lib/nurbs/types';
import { mapSegment2, sampleSegment, type PlaneSegment } from './planeSegments';
import type { FaceChart } from './chartFrame';

const lift2 = (curve: NurbsCurve2Data): NurbsCurveData => ({ ...curve, poles: curve.poles.map(([x, y]): Vec3 => [x, y, 0]) });
const drop3 = (curve: NurbsCurveData): NurbsCurve2Data => ({ ...curve, poles: curve.poles.map(([x, y]): Vec2 => [x, y]) });

export type Mapped<T> = T | { readonly error: string };
export const isMappingError = <T>(value: Mapped<T>): value is { readonly error: string } =>
  typeof value === 'object' && value !== null && 'error' in value;

/** Largest number of interpolation points tried by a fit. */
const MAX_FIT_POINTS = 1025;

type Sampler = (s: number) => Vec3 | null;

/**
 * A cubic curve through `sample(k / n)` for the smallest n (doubling from 8) whose deviation at three points between neighbours is within `tolerance`. The parameter is uniform, so
 * the curve and the sampler agree wherever both are evaluated at the same s.
 * @failure a sampler that answers null (a point on the cone apex, beyond a geodesic chart's reach), coincident samples, or no n within the cap reaching the tolerance -> error text
 */
export function fitBySampling(
  sample: Sampler,
  tolerance: number,
  nullMeaning = 'a point of the curve falls on the apex of the cone',
): Mapped<{ curve: NurbsCurveData; deviation: number }> {
  const apex = { error: nullMeaning };
  for (let n = 8; n < MAX_FIT_POINTS; n *= 2) {
    const points: Vec3[] = [];
    for (let k = 0; k <= n; k++) {
      const point = sample(k / n);
      if (point === null) return apex;
      points.push(point);
    }
    const fitted = interpolatePoints(points, { degree: 3, parameterization: 'uniform' });
    if ('code' in fitted) return { error: 'a curve of zero length cannot be fitted' };
    let deviation = 0;
    for (let k = 0; k < n; k++)
      for (const fraction of [0.25, 0.5, 0.75]) {
        const s = (k + fraction) / n;
        const exact = sample(s);
        if (exact === null) return apex;
        const got = evaluateCurve(fitted.curve, s);
        deviation = Math.max(deviation, Math.hypot(got[0] - exact[0], got[1] - exact[1], got[2] - exact[2]));
      }
    if (deviation <= tolerance) return { curve: fitted.curve, deviation };
  }
  return { error: 'a curve could not be fitted within the fit tolerance' };
}

/** The point of a planar segment at s in [0, 1] of its parameter range. */
function segmentPointAt(segment: PlaneSegment, s: number): Vec2 {
  if (segment.kind === 'line')
    return [segment.from[0] + s * (segment.to[0] - segment.from[0]), segment.from[1] + s * (segment.to[1] - segment.from[1])];
  const [first, last] = curveDomain(lift2(segment.curve));
  return pointAt2(segment.curve, first + s * (last - first));
}

/**
 * The smooth spans of a piece as samplers over s in [0, 1]. A rational curve (a circular arc) is only C1 where its pieces join, and an interpolating cubic loses its
 * order across such a break: it is fitted span by span. Every other piece is one span.
 */
function spansOf(segment: PlaneSegment): Array<(s: number) => Vec2> {
  if (segment.kind === 'nurbs' && segment.curve.weights !== undefined) {
    const { knots } = segment.curve;
    return knots.slice(0, -1).map((from, k) => {
      const to = knots[k + 1] as number;
      return (s: number): Vec2 => pointAt2(segment.curve, from + s * (to - from));
    });
  }
  return [(s: number): Vec2 => segmentPointAt(segment, s)];
}

/** The fitted cubic of each smooth span of a piece, with the largest measured deviation. */
function fitSpans(
  piece: PlaneSegment,
  map: (point: Vec2) => Vec3 | null,
  tolerance: number,
  nullMeaning?: string,
): Mapped<{ curves: NurbsCurveData[]; deviation: number }> {
  const curves: NurbsCurveData[] = [];
  let deviation = 0;
  for (const at of spansOf(piece)) {
    const fitted = fitBySampling((s) => map(at(s)), tolerance, nullMeaning);
    if (isMappingError(fitted)) return fitted;
    curves.push(fitted.curve);
    deviation = Math.max(deviation, fitted.deviation);
  }
  return { curves, deviation };
}

/**
 * One curve through a piece: its spans fitted (see `fitBySampling`) and joined C0.
 * @invariant fitted spans are non-rational, so the join cannot fail
 */
function fitPiece(
  piece: PlaneSegment,
  map: (point: Vec2) => Vec3 | null,
  tolerance: number,
): Mapped<{ curve: NurbsCurveData; deviation: number }> {
  const fitted = fitSpans(piece, map, tolerance);
  return isMappingError(fitted) ? fitted : { curve: joinCurves(fitted.curves) as NurbsCurveData, deviation: fitted.deviation };
}

/**
 * The pieces of one outline (a loop or an open chain, in order) as (u, v) pieces. A cone fits each smooth span as a 2D curve; `tolerance` (3D document units) is converted to (u, v).
 * @failure a cone point on the apex, or a fit that does not reach the tolerance -> error text
 */
export function mapPieces(chart: FaceChart, pieces: readonly PlaneSegment[], tolerance: number): Mapped<PlaneSegment[]> {
  if (chart.affine) {
    let outside = false;
    const affine = pieces.map((piece) =>
      mapSegment2(piece, (point) => {
        const uv = chart.uvAt(point);
        outside = outside || uv === null;
        return uv ?? [0, 0];
      }),
    );
    return outside ? { error: chart.nullMeaning } : affine;
  }
  const mapped: PlaneSegment[] = [];
  for (const piece of pieces) {
    const reach = Math.max(...sampleSegment(piece, 9).map((p) => Math.hypot(p[0] - chart.anchorChart[0], p[1] - chart.anchorChart[1])));
    const fitted = fitSpans(
      piece,
      (point) => {
        const uv = chart.uvAt(point);
        return uv === null ? null : [uv[0], uv[1], 0];
      },
      tolerance / chart.metricBound(reach),
      chart.nullMeaning,
    );
    if (isMappingError(fitted)) return fitted;
    for (const curve of fitted.curves) mapped.push({ kind: 'nurbs', curve: drop3(curve) });
  }
  return mapped;
}

const pieceAsCurve2 = (piece: PlaneSegment): NurbsCurve2Data => (piece.kind === 'line' ? bezier2([piece.from, piece.to]) : piece.curve);

/** 3D curve of one (u, v) piece: exact on a plane, a fit through its image otherwise. */
function pieceCurve3(
  chart: FaceChart,
  piece: PlaneSegment,
  tolerance: number,
  forceFit: boolean,
): Mapped<{ curve: NurbsCurveData; deviation: number }> {
  if (chart.kind === 'plane' && !forceFit) {
    const curve2 = pieceAsCurve2(piece);
    return { curve: { ...curve2, poles: curve2.poles.map((pole) => chart.pointAt(pole)) }, deviation: 0 };
  }
  return fitPiece(piece, (uv) => chart.pointAt(uv), tolerance);
}

/**
 * One 3D NURBS curve for the whole outline: pieces joined C0 (a join needs non-rational pieces, so a plane outline with several pieces and a rational one is
 * fitted instead).
 * @invariant every piece is non-rational when more than one is joined, so the join cannot fail
 */
export function curve3d(
  chart: FaceChart,
  pieces: readonly PlaneSegment[],
  tolerance: number,
): Mapped<{ curve: NurbsCurveData; deviation: number }> {
  const needsFit = pieces.length > 1 && pieces.some((piece) => piece.kind === 'nurbs' && piece.curve.weights !== undefined);
  const curves: NurbsCurveData[] = [];
  let deviation = 0;
  for (const piece of pieces) {
    const built = pieceCurve3(chart, piece, tolerance, needsFit);
    if (isMappingError(built)) return built;
    curves.push(built.curve);
    deviation = Math.max(deviation, built.deviation);
  }
  return { curve: joinCurves(curves) as NurbsCurveData, deviation };
}

/**
 * The pcurve of the whole outline in the face's (u, v): the single piece, or the C0 join of the pieces (rational pieces are fitted first, within `tolerance`).
 * @failure a rational piece that cannot be fitted within the tolerance -> error text
 * @invariant the joined pieces are non-rational, so the join cannot fail
 */
export function pcurveOf(pieces: readonly PlaneSegment[], tolerance: number): Mapped<NurbsCurve2Data> {
  if (pieces.length === 1) return pieceAsCurve2(pieces[0] as PlaneSegment);
  const flat: NurbsCurve2Data[] = [];
  for (const piece of pieces) {
    const curve = pieceAsCurve2(piece);
    if (curve.weights === undefined) {
      flat.push(curve);
      continue;
    }
    const fitted = fitPiece(piece, (point) => [point[0], point[1], 0], tolerance);
    if (isMappingError(fitted)) return fitted;
    flat.push(drop3(fitted.curve));
  }
  return drop3(joinCurves(flat.map(lift2)) as NurbsCurveData);
}

/** Length on the face of the (u, v) pieces: Richardson-extrapolated polyline lengths of their 3D images (error O(h^4)). */
export function lengthOnFace(chart: FaceChart, pieces: readonly PlaneSegment[]): number {
  let total = 0;
  for (const piece of pieces) {
    const polyline = (count: number): number => {
      const points = sampleSegment(piece, count).map((uv) => chart.pointAt(uv));
      let sum = 0;
      for (let k = 1; k < points.length; k++) {
        const [a, b] = [points[k - 1] as Vec3, points[k] as Vec3];
        sum += Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
      }
      return sum;
    };
    const coarse = polyline(257);
    const fine = polyline(513);
    total += fine + (fine - coarse) / 3;
  }
  return total;
}

/** The (u, v) extent of the pieces: the box of their sample points. */
export function extentOf(pieces: readonly PlaneSegment[]): { min: Vec2; max: Vec2 } {
  const points = pieces.flatMap((piece) => sampleSegment(piece, 33));
  return {
    min: [Math.min(...points.map((p) => p[0])), Math.min(...points.map((p) => p[1]))],
    max: [Math.max(...points.map((p) => p[0])), Math.max(...points.map((p) => p[1]))],
  };
}
