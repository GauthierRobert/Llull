/**
 * Deviation of one shape from another: sample the source (points, a patch grid, a curve, mesh vertices) and project every sample onto the
 * target (patch: Newton foot point; curve: Newton foot point; mesh: closest triangle point). Statistics are over the sample distances.
 */

import type { Vec3 } from '../../model/vectors';
import { cross3, distance3, dot3, normalize3, sub3 } from '../../lib/vec3';
import { closestOnCurve, closestOnSurface, surfaceProbe } from '../../lib/nurbs/closest';
import { curveDomain, evaluateCurve } from '../../lib/nurbs/evaluate';
import { evaluateSurface, surfaceDomain } from '../../lib/nurbs/surface';
import { surfaceSample } from '../../lib/nurbs/surfaceCurvature';
import { closestPointOnTriangle, type Triangle } from '../triangleQueries';
import type { DeviationReport, DeviationRequest, DeviationShape } from './types';

/** Source samples beyond this count are thinned evenly (keeps the cost of a mesh-to-mesh comparison bounded). */
const MAX_SAMPLES = 20_000;

/** Largest sample x triangle product of a projection onto a mesh (brute-force closest-triangle search). */
const MAX_MESH_PAIRS = 30_000_000;

const triangleNormal = ([a, b, c]: Triangle): Vec3 => normalize3(cross3(sub3(b, a), sub3(c, a)));

function sourcePoints(shape: DeviationShape, count: number): Vec3[] {
  switch (shape.type) {
    case 'points':
      return [...shape.points];
    case 'curve': {
      const [first, last] = curveDomain(shape.curve);
      return Array.from({ length: Math.max(2, count) }, (_, i) =>
        evaluateCurve(shape.curve, first + ((last - first) * i) / (Math.max(2, count) - 1)),
      );
    }
    case 'surface': {
      const [[u0, u1], [v0, v1]] = surfaceDomain(shape.surface);
      const n = Math.max(2, count);
      const points: Vec3[] = [];
      for (let i = 0; i < n; i++)
        for (let j = 0; j < n; j++)
          points.push(evaluateSurface(shape.surface, u0 + ((u1 - u0) * i) / (n - 1), v0 + ((v1 - v0) * j) / (n - 1)));
      return points;
    }
    case 'mesh':
      return shape.triangles.flatMap(([a, b, c]): Vec3[] => [
        a,
        b,
        c,
        [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3],
      ]);
  }
}

interface Foot {
  readonly foot: Vec3;
  readonly distance: number;
  /** Signed distance along the target surface normal (surface targets only). */
  readonly signed: number | null;
}

/** Projection function of the target shape; the expensive set-up (probe grid) is built once. */
function projector(target: DeviationRequest['to']): (point: Vec3) => Foot {
  switch (target.type) {
    case 'surface': {
      const probe = surfaceProbe(target.surface);
      return (point) => {
        const hit = closestOnSurface(target.surface, point, probe);
        const sample = surfaceSample(target.surface, hit.u, hit.v);
        return { foot: hit.point, distance: hit.distance, signed: sample.degenerate ? null : dot3(sub3(point, hit.point), sample.normal) };
      };
    }
    case 'curve':
      return (point) => {
        const hit = closestOnCurve(target.curve, point);
        return { foot: hit.point, distance: hit.distance, signed: null };
      };
    case 'mesh':
      return (point) => {
        let best: Foot = { foot: point, distance: Infinity, signed: null };
        for (const triangle of target.triangles) {
          const foot = closestPointOnTriangle(point, triangle);
          const distance = distance3(point, foot);
          if (distance < best.distance) best = { foot, distance, signed: dot3(sub3(point, foot), triangleNormal(triangle)) };
        }
        return best;
      };
  }
}

const percentile = (sorted: ReadonlyArray<number>, fraction: number): number =>
  sorted[Math.min(sorted.length - 1, Math.floor(fraction * (sorted.length - 1) + 0.5))] as number;

/**
 * @invariant `count` samples, every distance >= 0; an empty source or an empty target mesh gives all-zero statistics with count 0
 */
export function measureDeviation(request: DeviationRequest): DeviationReport {
  let points = sourcePoints(request.from, request.samples);
  if (points.length > MAX_SAMPLES) {
    const stride = Math.ceil(points.length / MAX_SAMPLES);
    points = points.filter((_, index) => index % stride === 0);
  }
  if (request.to.type === 'mesh' && request.to.triangles.length > 0) {
    const stride = Math.ceil((points.length * request.to.triangles.length) / MAX_MESH_PAIRS);
    if (stride > 1) points = points.filter((_, index) => index % stride === 0);
  }
  const emptyTarget = request.to.type === 'mesh' && request.to.triangles.length === 0;
  if (points.length === 0 || emptyTarget)
    return {
      count: 0,
      max: 0,
      mean: 0,
      rms: 0,
      p95: 0,
      worst: { point: [0, 0, 0], foot: [0, 0, 0], distance: 0 },
      signed: null,
      histogram: new Array<number>(10).fill(0),
    };
  const project = projector(request.to);
  const feet = points.map(project);
  const distances = feet.map((foot) => foot.distance);
  let worstIndex = 0;
  distances.forEach((distance, index) => {
    if (distance > (distances[worstIndex] as number)) worstIndex = index;
  });
  const sorted = [...distances].sort((a, b) => a - b);
  const max = sorted[sorted.length - 1] as number;
  const mean = distances.reduce((sum, d) => sum + d, 0) / distances.length;
  const rms = Math.sqrt(distances.reduce((sum, d) => sum + d * d, 0) / distances.length);
  const signedValues = feet.flatMap((foot) => (foot.signed === null ? [] : [foot.signed]));
  const histogram = new Array<number>(10).fill(0);
  for (const distance of distances) histogram[max === 0 ? 0 : Math.min(9, Math.floor((distance / max) * 10))]! += 1;
  const worstFoot = feet[worstIndex] as Foot;
  return {
    count: distances.length,
    max,
    mean,
    rms,
    p95: percentile(sorted, 0.95),
    worst: { point: points[worstIndex] as Vec3, foot: worstFoot.foot, distance: worstFoot.distance },
    signed:
      request.to.type === 'surface' && signedValues.length === distances.length
        ? {
            mean: signedValues.reduce((sum, d) => sum + d, 0) / signedValues.length,
            min: Math.min(...signedValues),
            max: Math.max(...signedValues),
          }
        : null,
    histogram,
  };
}
