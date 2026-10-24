/**
 * The three constructions of `create_curve_on_face` (03 WRP): a geodesic between two points (the straight line of the geodesic chart anchored at the first point),
 * an isoparametric curve (u or v constant, trimmed to the face), and a curve through (u, v) points in the kernel's own parameters.
 * @failure points off the face, a geodesic that cannot be found, a curve leaving the face or not fitting the tolerance -> `{ code, message, path }`
 */

import type { Vec2, Vec3 } from '../../model/vectors';
import { bezier2, pointAt2, type NurbsCurve2Data } from '../../lib/nurbs/curve2d';
import { distance3 } from '../../lib/vec3';
import { interpolatePoints } from '../../lib/nurbs/interpolate';
import type { NurbsCurveData } from '../../lib/nurbs/types';
import { buildChart } from '../../geometry/faceChart';
import { chartPointOf } from '../../geometry/chartInverse';
import { fitDenseSamples } from '../../geometry/denseFit';
import type { PlaneSegment } from '../../geometry/planeSegments';
import { curve3d, isMappingError, lengthOnFace, mapPieces, pcurveOf } from '../../geometry/wrapCurves';
import type { FaceSession } from './faceSession';
import { checkOnFace } from './wrapMapping';

export interface BuiltCurve {
  readonly curve: NurbsCurveData;
  readonly pcurve: NurbsCurve2Data;
  /** `native`: the pcurve is in the kernel's own (u, v); otherwise in the chart frame of the geodesic. */
  readonly frame: 'native' | 'chart';
  /** Largest measured deviation of the 3D curve from its exact image (document units). */
  readonly fitTolerance: number;
  readonly chartLength: number;
  readonly length3d: number;
  readonly exact: boolean;
  readonly method: string;
}

export interface BuildFailure {
  readonly code: string;
  readonly message: string;
  readonly path: string;
}

export const isBuildFailure = (value: BuiltCurve | BuildFailure): value is BuildFailure => 'code' in value;

const DENSE = 1025;
const PROBES = 33;

const lengthOfPolyline = (points: readonly Vec3[]): number =>
  points
    .slice(1)
    .reduce(
      (sum, p, k) => sum + Math.hypot(p[0] - (points[k] as Vec3)[0], p[1] - (points[k] as Vec3)[1], p[2] - (points[k] as Vec3)[2]),
      0,
    );

/** The projection of `point` onto the face, or the reason it is not on it. */
function onFace(session: FaceSession, point: Vec3, path: string): { point: Vec3; uv: Vec2 } | BuildFailure {
  const hit = session.query.projectOnFace(session.shape, session.face, [point])?.[0] ?? null;
  if (hit === null) return { code: 'WRP_ANCHOR_OFF_FACE', message: `${path} could not be projected onto face ${session.face}`, path };
  if (hit.distance > 1e-3 * session.diagonal)
    return {
      code: 'WRP_ANCHOR_OFF_FACE',
      message: `${path} is ${hit.distance} from face ${session.face} (limit ${1e-3 * session.diagonal})`,
      path,
    };
  return { point: hit.point, uv: hit.uv };
}

/** Geodesic from `from` to `to` (points on or near the face). */
export function geodesicCurve(session: FaceSession, from: Vec3, to: Vec3, tolerance: number): BuiltCurve | BuildFailure {
  const start = onFace(session, from, 'from');
  if ('code' in start) return start;
  const end = onFace(session, to, 'to');
  if ('code' in end) return end;
  const chart = buildChart(session.surface, { anchorChart: [0, 0], anchorOn: start.point, angleDeg: 0, mirror: false }, 'geodesic');
  if ('error' in chart) {
    const unsupported = chart.error === 'unsupported_surface';
    return {
      code: unsupported ? 'WRP_METHOD_UNAVAILABLE' : 'WRP_GEODESIC_FAILED',
      message: unsupported
        ? `face ${session.face} is a freeform surface; geodesics are built for plane, cylinder, cone, sphere and torus faces`
        : chart.error,
      path: 'from',
    };
  }
  const target = chartPointOf(chart, end.point);
  if ('error' in target) return { code: 'WRP_GEODESIC_FAILED', message: target.error, path: 'to' };
  const segment: PlaneSegment = { kind: 'line', from: [0, 0], to: target };
  const mapped = mapPieces(chart, [segment], tolerance);
  if (isMappingError(mapped)) return { code: 'WRP_GEODESIC_FAILED', message: mapped.error, path: 'to' };
  const image = curve3d(chart, mapped, tolerance);
  if (isMappingError(image)) return { code: 'WRP_GEODESIC_FAILED', message: image.error, path: 'to' };
  const pcurve = pcurveOf(mapped, tolerance / chart.metricBound(0));
  if (isMappingError(pcurve)) return { code: 'WRP_GEODESIC_FAILED', message: pcurve.error, path: 'to' };
  const endUv = chart.uvAt(target);
  const gap = endUv === null ? Number.POSITIVE_INFINITY : distance3(chart.pointAt(endUv), end.point);
  if (!(gap <= 1e-4 * session.diagonal))
    return {
      code: 'WRP_GEODESIC_FAILED',
      message: `the geodesic ends ${gap} from the second point (limit ${1e-4 * session.diagonal})`,
      path: 'to',
    };
  const probes = Array.from({ length: PROBES }, (_, k) =>
    chart.uvAt([(target[0] * k) / (PROBES - 1), (target[1] * k) / (PROBES - 1)]),
  ).flatMap((uv) => (uv === null ? [] : [chart.pointAt(uv)]));
  const outside = checkOnFace(session, probes, []);
  if (outside !== null) return { code: 'WRP_OUTSIDE_FACE', message: outside.message, path: 'to' };
  return {
    curve: image.curve,
    pcurve,
    frame: 'chart',
    fitTolerance: image.deviation,
    chartLength: Math.hypot(target[0], target[1]),
    length3d: lengthOnFace(chart, mapped),
    exact: image.deviation === 0,
    method: `geodesic by the ${chart.kind === 'plane' || chart.kind === 'cylinder' || chart.kind === 'cone' ? 'development' : 'exponential map'} of the ${chart.kind} face`,
  };
}

/** The curve of a pcurve in the kernel's own (u, v): kernel evaluation of 1025 samples, fitted and checked on the face. */
function nativeCurve(session: FaceSession, pcurve: NurbsCurve2Data, tolerance: number, method: string): BuiltCurve | BuildFailure {
  const [first, last] = [pcurve.knots[0] ?? 0, pcurve.knots[pcurve.knots.length - 1] ?? 1];
  const uv = Array.from({ length: DENSE }, (_, k) => pointAt2(pcurve, first + ((last - first) * k) / (DENSE - 1)));
  const evaluated = session.query.evaluateFace(session.shape, session.face, uv);
  if (evaluated === null)
    return { code: 'WRP_OUTSIDE_FACE', message: `the kernel could not evaluate face ${session.face} along the curve`, path: 'uv' };
  const dense = evaluated.map((e) => e.point);
  const probes = Array.from({ length: PROBES }, (_, k) => dense[Math.round((k * (DENSE - 1)) / (PROBES - 1))] as Vec3);
  const outside = checkOnFace(session, probes, []);
  if (outside !== null) return { code: 'WRP_OUTSIDE_FACE', message: outside.message, path: 'uv' };
  const fitted = fitDenseSamples(dense, tolerance);
  if ('error' in fitted) return { code: 'WRP_KERNEL_BUILD_FAILED', message: fitted.error, path: 'uv' };
  const length3d = lengthOfPolyline(dense);
  return {
    curve: fitted.curve,
    pcurve,
    frame: 'native',
    fitTolerance: fitted.deviation,
    chartLength: length3d,
    length3d,
    exact: false,
    method,
  };
}

/** Curve through `points` (kernel (u, v)), cubic through them (a line for two). */
export function uvCurve(session: FaceSession, points: readonly Vec2[], tolerance: number): BuiltCurve | BuildFailure {
  const lifted = points.map(([u, v]): Vec3 => [u, v, 0]);
  const fitted = interpolatePoints(lifted, { degree: Math.min(3, points.length - 1), parameterization: 'chord' });
  if ('code' in fitted) return { code: 'WRP_PARAM_INVALID', message: `uv points do not define a curve (${fitted.message})`, path: 'uv' };
  const pcurve: NurbsCurve2Data = { ...fitted.curve, poles: fitted.curve.poles.map(([u, v]): Vec2 => [u, v]) };
  return nativeCurve(session, pcurve, tolerance, 'cubic through the (u, v) points, evaluated by the kernel');
}

/** Isoparametric curve through `through`: u constant ('v' direction varies) or v constant, the run of the face containing the point. */
export function isoCurve(session: FaceSession, through: Vec3, vary: 'u' | 'v', tolerance: number): BuiltCurve | BuildFailure {
  const hit = onFace(session, through, 'through');
  if ('code' in hit) return hit;
  const [[uLow, vLow], [uHigh, vHigh]] = session.uvBounds;
  const [low, high] = vary === 'u' ? [uLow, uHigh] : [vLow, vHigh];
  if (!Number.isFinite(low) || !Number.isFinite(high))
    return { code: 'WRP_PARAM_INVALID', message: `face ${session.face} has an unbounded ${vary} range`, path: 'direction' };
  const at = (t: number): Vec2 => (vary === 'u' ? [t, hit.uv[1]] : [hit.uv[0], t]);
  const inside = (t: number): boolean => {
    const point = session.query.evaluateFace(session.shape, session.face, [at(t)])?.[0]?.point;
    return point !== undefined && session.query.faceContains(session.shape, session.face, point, 1e-6 * session.diagonal) === true;
  };
  const here = vary === 'u' ? hit.uv[0] : hit.uv[1];
  const edge = (limit: number): number => {
    if (inside(limit)) return limit;
    let [good, bad] = [here, limit];
    for (let step = 0; step < 40; step++) {
      const mid = (good + bad) / 2;
      if (inside(mid)) good = mid;
      else bad = mid;
    }
    return good;
  };
  const [first, last] = [edge(low), edge(high)];
  if (!(last - first > 1e-12))
    return { code: 'WRP_OUTSIDE_FACE', message: 'the isoparametric curve through the point has no length on the face', path: 'through' };
  return nativeCurve(
    session,
    bezier2([at(first), at(last)]),
    tolerance,
    `isoparametric ${vary === 'u' ? 'v' : 'u'} = const, trimmed to the face, evaluated by the kernel`,
  );
}
