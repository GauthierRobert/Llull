import type { Vec2, Vec3 } from '../../model/types';
import type { ChartMethod, FaceChart } from '../../geometry/chartFrame';
import { chartPointOf } from '../../geometry/chartInverse';
import { buildChart } from '../../geometry/faceChart';
import { distance3 } from '../../lib/vec3';
import type { FaceSession } from './faceSession';
import { maxOf } from '../../lib/arrayExtrema';

const TWO_PI = 2 * Math.PI;

/** The inverse of an affine chart: chart coordinates of (u, v). */
function inverseOf(chart: FaceChart): ((uv: Vec2) => Vec2) | null {
  const o = chart.uvAt([0, 0]);
  const a = chart.uvAt([1, 0]);
  const b = chart.uvAt([0, 1]);
  if (o === null || a === null || b === null) return null;
  const [m00, m10, m01, m11] = [a[0] - o[0], a[1] - o[1], b[0] - o[0], b[1] - o[1]];
  const det = m00 * m11 - m01 * m10;
  if (!(Math.abs(det) > 1e-300)) return null;
  return ([u, v]) => [(m11 * (u - o[0]) - m01 * (v - o[1])) / det, (-m10 * (u - o[0]) + m00 * (v - o[1])) / det];
}

/**
 * Chart coordinates of surface points of a face. The azimuth of a cylinder is taken in the turn that holds the face's own u range (a face spans less than one turn, so the
 * representative of each point is unique, also for the points of a half-turn face where a nearest-turn rule is ambiguous).
 */
/**
 * Chart coordinates of surface points on a chart that is not affine (cone, sphere, torus): the natural coordinates of `chartPointOf` turned back by the chart's own placement (the
 * rotation and mirror D with natural = D (q - anchorChart), found from two probes of the chart).
 */
function polarCoordinates(chart: FaceChart, points: readonly Vec3[]): Vec2[] | null {
  const eps = 1e-3;
  const columns: Vec2[] = [];
  for (const step of [
    [eps, 0],
    [0, eps],
  ] as const) {
    const uv = chart.uvAt([chart.anchorChart[0] + step[0], chart.anchorChart[1] + step[1]]);
    if (uv === null) return null;
    const natural = chartPointOf(chart, chart.pointAt(uv));
    if ('error' in natural) return null;
    columns.push([natural[0] / eps, natural[1] / eps]);
  }
  const [c0, c1] = columns as [Vec2, Vec2];
  const det = c0[0] * c1[1] - c1[0] * c0[1];
  if (!(Math.abs(det) > 1e-300)) return null;
  const out: Vec2[] = [];
  for (const point of points) {
    // the anchor itself has no direction: its natural coordinates are the origin
    const home = chart.pointAt(chart.anchorUv);
    const natural =
      distance3(point, home) < 1e-9 * (1 + Math.abs(home[0]) + Math.abs(home[1]) + Math.abs(home[2]))
        ? ([0, 0] as Vec2)
        : chartPointOf(chart, point);
    if ('error' in natural) return null;
    // q - anchor = D^-1 natural, D = [c0 c1] (columns)
    out.push([
      chart.anchorChart[0] + (c1[1] * natural[0] - c1[0] * natural[1]) / det,
      chart.anchorChart[1] + (-c0[1] * natural[0] + c0[0] * natural[1]) / det,
    ]);
  }
  return out;
}

export function chartCoordinates(chart: FaceChart, points: readonly Vec3[], bounds: FaceSession['uvBounds']): Vec2[] | null {
  if (chart.kind !== 'plane' && chart.kind !== 'cylinder') return polarCoordinates(chart, points);
  const inverse = inverseOf(chart);
  if (inverse === null) return null;
  const centre = (bounds[0][0] + bounds[1][0]) / 2;
  const turn = chart.kind === 'cylinder' ? TWO_PI * Math.round((centre - chart.anchorUv[0]) / TWO_PI) : 0;
  return points.map((point) => {
    const uv = chart.uvOfPoint(point);
    // the face's own turn, expressed against the branch of the chart anchor (chart coordinates are measured from the anchor)
    const u = chart.kind === 'cylinder' ? uv[0] + TWO_PI * Math.round((centre - uv[0]) / TWO_PI) - turn : uv[0];
    return inverse([u, uv[1]]);
  });
}

export const dist2 = (a: Vec2, b: Vec2): number => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** Largest extent of a set of points (the scale a closed edge's coincident ends are judged against). */
export const edgeScale = (points: readonly Vec3[]): number => maxOf(points.map((p) => distance3(p, points[0] as Vec3)));

/** Largest distance of the points from the line through the first and the last. */
export function straightness(points: readonly Vec2[]): number {
  const [first, last] = [points[0] as Vec2, points[points.length - 1] as Vec2];
  const length = dist2(first, last);
  if (!(length > 0)) return Infinity;
  const d: Vec2 = [(last[0] - first[0]) / length, (last[1] - first[1]) / length];
  return maxOf(points.map((p) => Math.abs(d[0] * (p[1] - first[1]) - d[1] * (p[0] - first[0]))));
}

export interface Candidate {
  readonly chart: FaceChart;
  readonly mirror: boolean;
  readonly residual: number;
}

/** The charts of a child face carrying the chain's coordinates `chainPoints` of the 3D edge points `points` (anchored on the first), or null when none reproduces them. */
export function childChart(
  session: FaceSession,
  points: readonly Vec3[],
  chainPoints: readonly Vec2[],
  handedness: 1 | -1,
  orientation: 1 | -1,
  method: ChartMethod,
  /** Index of the edge sample the child chart is anchored on (the one nearest where the sketch crosses). */
  at: number,
): Candidate[] {
  const preferredMirror = orientation !== handedness;
  const pivot = chainPoints[at] as Vec2;
  const found: Candidate[] = [];
  for (const mirror of [preferredMirror, !preferredMirror]) {
    const own = buildChart(session.surface, { anchorChart: [0, 0], anchorOn: points[at] as Vec3, angleDeg: 0, mirror }, method);
    if ('error' in own) return [];
    const d = chartCoordinates(own, points, session.uvBounds);
    if (d === null) return [];
    const v = chainPoints.map((p): Vec2 => [p[0] - pivot[0], p[1] - pivot[1]]);
    let dot = 0;
    let cross = 0;
    for (const [k, vk] of v.entries()) {
      const dk: Vec2 = [(d[k] as Vec2)[0] - (d[at] as Vec2)[0], (d[k] as Vec2)[1] - (d[at] as Vec2)[1]];
      dot += dk[0] * vk[0] + dk[1] * vk[1];
      cross += dk[0] * vk[1] - dk[1] * vk[0];
    }
    const alpha = Math.atan2(cross, dot);
    for (const angle of [alpha, -alpha]) {
      const chart = buildChart(
        session.surface,
        { anchorChart: pivot, anchorOn: points[at] as Vec3, angleDeg: (angle * 180) / Math.PI, mirror },
        method,
      );
      if ('error' in chart) continue;
      const residual = maxOf(
        points.map((point, k) => {
          const uv = chart.uvAt(chainPoints[k] as Vec2);
          return uv === null ? Infinity : distance3(chart.pointAt(uv), point);
        }),
      );
      found.push({ chart, mirror, residual });
    }
  }
  return found.sort((a, b) => a.residual - b.residual);
}
