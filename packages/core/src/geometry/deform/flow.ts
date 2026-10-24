/**
 * Flow of a body along a curve (01 DEF §5.4): the frame axis (a straight base) is laid onto a target curve; the point (x, y, z) goes to
 * P(s) + x N(s) + y B(s), s = ratio (z - z0), with (T, N, B) a frame along the curve. Arc length along the base is kept (ratio 1) or scaled to the
 * target length (`stretch`). On a circular target this is exactly `bend` (VC-DEF-18).
 *
 * The target is sampled once, at uniform arc length, into a table of stations (P, T, N, B) stored in the law, so the TypeScript map, the Manifold /
 * no-kernel mesh path and the native exact warp evaluate the SAME function (cubic Hermite on P, normalised linear blend of the frames).
 * @invariant frames are rotation minimising (double reflection, Wang et al. 2008) or `fixed_up` (N toward the up vector projected perpendicular to T)
 */

import type { DeformLaw } from '../../model/deform';
import type { Vec3 } from '../../model/vectors';
import { add3, cross3, dot3, len3, normalize3, scale3, sub3 } from '../../lib/vec3';
import { curveDerivatives, curveDomain } from '../../lib/nurbs/evaluate';
import type { NurbsCurveData } from '../../lib/nurbs/types';

export type FlowLaw = Extract<DeformLaw, { kind: 'flowCurve' }>;

/** Numbers per station: P, T, N, B. */
const STRIDE = 12;

/** Largest station count of a table. */
const MAX_FLOW_STATIONS = 4096;

const at = (stations: ReadonlyArray<number>, k: number, offset: number): Vec3 => [
  stations[k * STRIDE + offset] as number,
  stations[k * STRIDE + offset + 1] as number,
  stations[k * STRIDE + offset + 2] as number,
];

/** Station count of a law's table. */
const stationCount = (law: FlowLaw): number => law.stations.length / STRIDE;

interface Sample {
  readonly point: Vec3;
  readonly frame: { readonly t: Vec3; readonly n: Vec3; readonly b: Vec3 };
}

/** P, T, N, B at arc length `s` of the table (extended straight beyond both ends). */
function sampleAt(law: FlowLaw, s: number): Sample {
  const count = stationCount(law);
  const length = (count - 1) * law.step;
  const clamped = Math.min(Math.max(s, 0), length);
  const k = Math.min(Math.floor(clamped / law.step), count - 2);
  const u = (clamped - k * law.step) / law.step;
  const [p0, p1, t0, t1] = [at(law.stations, k, 0), at(law.stations, k + 1, 0), at(law.stations, k, 3), at(law.stations, k + 1, 3)];
  const [u2, u3] = [u * u, u * u * u];
  const [h00, h10, h01, h11] = [2 * u3 - 3 * u2 + 1, u3 - 2 * u2 + u, -2 * u3 + 3 * u2, u3 - u2];
  const [d00, d10, d01, d11] = [6 * u2 - 6 * u, 3 * u2 - 4 * u + 1, -6 * u2 + 6 * u, 3 * u2 - 2 * u];
  const h = law.step;
  const point = add3(add3(scale3(p0, h00), scale3(t0, h10 * h)), add3(scale3(p1, h01), scale3(t1, h11 * h)));
  const slope = add3(add3(scale3(p0, d00 / h), scale3(t0, d10)), add3(scale3(p1, d01 / h), scale3(t1, d11)));
  const tangent = normalize3(slope);
  const blended = add3(scale3(at(law.stations, k, 6), 1 - u), scale3(at(law.stations, k + 1, 6), u));
  const normal = normalize3(sub3(blended, scale3(tangent, dot3(blended, tangent))));
  const binormal = cross3(tangent, normal);
  if (s >= 0 && s <= length) return { point, frame: { t: tangent, n: normal, b: binormal } };
  const extra = s < 0 ? s : s - length;
  return { point: add3(point, scale3(tangent, extra)), frame: { t: tangent, n: normal, b: binormal } };
}

/** The image of local point `q`. */
export function flowMap(law: FlowLaw, q: Vec3): Vec3 {
  const { point, frame } = sampleAt(law, law.ratio * (q[2] - law.z0));
  return add3(point, add3(scale3(frame.n, q[0]), scale3(frame.b, q[1])));
}

/** det J of the flow at `q`, by central differences of the map (the table is only piecewise smooth). */
export function flowDeterminant(law: FlowLaw, q: Vec3): number {
  const h = 1e-6 * Math.max(1, Math.abs(q[0]), Math.abs(q[1]), Math.abs(q[2]), law.step);
  const column = (axis: 0 | 1 | 2): Vec3 => {
    const plus: [number, number, number] = [q[0], q[1], q[2]];
    const minus: [number, number, number] = [q[0], q[1], q[2]];
    plus[axis] += h;
    minus[axis] -= h;
    return scale3(sub3(flowMap(law, plus), flowMap(law, minus)), 1 / (2 * h));
  };
  return dot3(column(0), cross3(column(1), column(2)));
}

/** Largest curvature of the target over the table (1 / document units), from the change of the tangent between stations. */
function maxCurvature(law: FlowLaw): number {
  let worst = 0;
  for (let k = 0; k + 1 < stationCount(law); k++)
    worst = Math.max(worst, len3(sub3(at(law.stations, k + 1, 3), at(law.stations, k, 3))) / law.step);
  return worst;
}

export interface FlowOptions {
  /** Where the base starts along the frame axis (local z). */
  readonly z0: number;
  /** Length of the base along the axis that flows (document units). */
  readonly baseLength: number;
  readonly stretch: boolean;
  readonly orientation: 'minimal' | 'fixed_up';
  readonly up?: Vec3 | undefined;
  /** Largest error of the frame table (document units) at the lateral half extent `lateral`. */
  readonly tolerance: number;
  readonly lateral: number;
  /** Direction of the first normal (unit, perpendicular to the first tangent), for the rotation-minimising frame. */
  readonly initialNormal: Vec3;
}

export type FlowFailure = 'CURVE_DEGENERATE' | 'UP_PARALLEL';

/** Arc length table of a curve: parameters and cumulative lengths at `count + 1` uniform parameter steps (Simpson per step). */
function arcTable(curve: NurbsCurveData, count: number): { u: number[]; s: number[] } {
  const [first, last] = curveDomain(curve);
  const speed = (u: number): number => len3(curveDerivatives(curve, u, 1)[1] as Vec3);
  const us: number[] = [];
  const ss: number[] = [0];
  for (let i = 0; i <= count; i++) us.push(first + ((last - first) * i) / count);
  for (let i = 0; i < count; i++) {
    const [a, b] = [us[i] as number, us[i + 1] as number];
    ss.push((ss[i] as number) + ((b - a) / 6) * (speed(a) + 4 * speed((a + b) / 2) + speed(b)));
  }
  return { u: us, s: ss };
}

/** Parameter of the curve at arc length `s` (linear inside the table interval, two Newton steps). */
function parameterAt(curve: NurbsCurveData, table: { u: number[]; s: number[] }, s: number): number {
  const total = table.s[table.s.length - 1] as number;
  const target = Math.min(Math.max(s, 0), total);
  let lo = 0;
  let hi = table.s.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if ((table.s[mid] as number) <= target) lo = mid;
    else hi = mid;
  }
  const [s0, s1, u0, u1] = [table.s[lo] as number, table.s[hi] as number, table.u[lo] as number, table.u[hi] as number];
  let u = s1 === s0 ? u0 : u0 + ((u1 - u0) * (target - s0)) / (s1 - s0);
  for (let i = 0; i < 2; i++) {
    const speed = len3(curveDerivatives(curve, u, 1)[1] as Vec3);
    if (speed === 0) break;
    const arc = s0 + integrateSpeed(curve, u0, u);
    u += (target - arc) / speed;
    u = Math.min(Math.max(u, u0), u1);
  }
  return u;
}

function integrateSpeed(curve: NurbsCurveData, from: number, to: number): number {
  const speed = (u: number): number => len3(curveDerivatives(curve, u, 1)[1] as Vec3);
  const mid = (from + to) / 2;
  return ((to - from) / 6) * (speed(from) + 4 * speed(mid) + speed(to));
}

/**
 * The law that lays a base of `options.baseLength` along the frame axis onto `target`.
 * @failure target of zero length or tangent -> 'CURVE_DEGENERATE'; fixed_up with an up vector parallel to a tangent -> 'UP_PARALLEL'
 */
export function buildFlowLaw(target: NurbsCurveData, options: FlowOptions): FlowLaw | FlowFailure {
  const coarse = arcTable(target, 512);
  const total = coarse.s[coarse.s.length - 1] as number;
  if (!(total > 0) || !(options.baseLength > 0)) return 'CURVE_DEGENERATE';
  const length = options.stretch ? total : Math.min(total, options.baseLength);
  const ratio = options.stretch ? total / options.baseLength : 1;
  // stations: the frame error of linear blending is about (κ h)² ρ / 8; refine from a first guess of κ
  let count = 64;
  for (let pass = 0; pass < 6; pass++) {
    const law = tableFor(target, coarse, length, ratio, count, options);
    if (typeof law === 'string') return law;
    const kappa = maxCurvature(law);
    const h = law.step;
    const error = ((kappa * h) ** 2 * Math.max(options.lateral, 1e-12)) / 8 + (kappa * h) ** 4 * 1e-3;
    if (error <= options.tolerance * 0.25 || count >= MAX_FLOW_STATIONS) return law;
    count = Math.min(MAX_FLOW_STATIONS, count * 2);
  }
  return tableFor(target, coarse, length, ratio, MAX_FLOW_STATIONS, options);
}

function tableFor(
  target: NurbsCurveData,
  arcs: { u: number[]; s: number[] },
  length: number,
  ratio: number,
  count: number,
  options: FlowOptions,
): FlowLaw | FlowFailure {
  const step = length / (count - 1);
  const points: Vec3[] = [];
  const tangents: Vec3[] = [];
  for (let k = 0; k < count; k++) {
    const u = parameterAt(target, arcs, k * step);
    const [point, first] = curveDerivatives(target, u, 1) as [Vec3, Vec3];
    if (len3(first) === 0) return 'CURVE_DEGENERATE';
    points.push(point);
    tangents.push(normalize3(first));
  }
  const normals: Vec3[] = [];
  if (options.orientation === 'fixed_up') {
    const up = options.up ?? [0, 0, 1];
    for (const t of tangents) {
      const across = sub3(up, scale3(t, dot3(up, t)));
      if (len3(across) < 1e-9 * len3(up)) return 'UP_PARALLEL';
      normals.push(normalize3(across));
    }
  } else {
    const t0 = tangents[0] as Vec3;
    let n = normalize3(sub3(options.initialNormal, scale3(t0, dot3(options.initialNormal, t0))));
    normals.push(n);
    for (let k = 0; k + 1 < count; k++) {
      // double reflection: carry n from station k to k + 1
      const [x0, x1, t0k, t1k] = [points[k] as Vec3, points[k + 1] as Vec3, tangents[k] as Vec3, tangents[k + 1] as Vec3];
      const v1 = sub3(x1, x0);
      const c1 = Math.max(dot3(v1, v1), 1e-300);
      const rL = sub3(n, scale3(v1, (2 / c1) * dot3(v1, n)));
      const tL = sub3(t0k, scale3(v1, (2 / c1) * dot3(v1, t0k)));
      const v2 = sub3(t1k, tL);
      const c2 = dot3(v2, v2);
      n = c2 === 0 ? rL : sub3(rL, scale3(v2, (2 / c2) * dot3(v2, rL)));
      n = normalize3(sub3(n, scale3(t1k, dot3(n, t1k))));
      normals.push(n);
    }
  }
  const stations: number[] = [];
  for (let k = 0; k < count; k++) {
    const t = tangents[k] as Vec3;
    const n = normals[k] as Vec3;
    stations.push(...(points[k] as Vec3), ...t, ...n, ...cross3(t, n));
  }
  return { kind: 'flowCurve', z0: options.z0, ratio, step, stations };
}
