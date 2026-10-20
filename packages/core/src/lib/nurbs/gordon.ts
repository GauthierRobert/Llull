/**
 * Gordon surface through a curve network (sections x guides), built by sampling: S = L_sections + L_guides - T (transfinite union minus
 * the tensor interpolant of the intersection points), with the curves re-timed piecewise-linearly so every guide meets every section at
 * common parameters, then fitted by global interpolation (`interpolateGrid`). The result passes through the network within `deviation`.
 */

import type { Vec3 } from '../../model/vectors';
import { distance3 } from '../vec3';
import { basisFunctions, findSpan } from './basis';
import { solveBanded } from './bandSolve';
import { closestOnCurve, closestOnSurface, surfaceProbe } from './closest';
import { curveDomain, evaluateCurve } from './evaluate';
import { interpolateGrid } from './surfaceFit';
import type { NurbsSurfaceData } from './surfaceTypes';
import type { NurbsCurveData } from './types';

export type GordonResult =
  | { readonly surface: NurbsSurfaceData; readonly deviation: number; readonly gap: number }
  | {
      readonly code: 'SRF_LOFT_GUIDE_MISSES_SECTION' | 'SRF_NURBS_INVALID';
      readonly message: string;
      readonly guide?: number;
      readonly section?: number;
    };

/** Parameter of `curve` normalised to [0, 1]. */
const at = (curve: NurbsCurveData, t: number): Vec3 => {
  const [a, b] = curveDomain(curve);
  return evaluateCurve(curve, a + (b - a) * t);
};

/** Closest points between two curves by alternating projection from the best of a coarse sampling: [parameter on a, parameter on b, gap], all in 0..1. */
function meet(a: NurbsCurveData, b: NurbsCurveData): [number, number, number] {
  let best: [number, number, number] = [0, 0, Infinity];
  const count = 40;
  for (let i = 0; i <= count; i++) {
    const point = at(a, i / count);
    const hit = closestOnCurve(b, point);
    const tb = (hit.t - curveDomain(b)[0]) / (curveDomain(b)[1] - curveDomain(b)[0]);
    if (hit.distance < best[2]) best = [i / count, tb, hit.distance];
  }
  let [ta, tb] = [best[0], best[1]];
  for (let step = 0; step < 30; step++) {
    const onA = closestOnCurve(a, at(b, tb));
    ta = (onA.t - curveDomain(a)[0]) / (curveDomain(a)[1] - curveDomain(a)[0]);
    const onB = closestOnCurve(b, at(a, ta));
    tb = (onB.t - curveDomain(b)[0]) / (curveDomain(b)[1] - curveDomain(b)[0]);
  }
  return [ta, tb, distance3(at(a, ta), at(b, tb))];
}

/** Piecewise-linear map through the node pairs (x[k] -> y[k]), clamped outside. */
function piecewise(x: ReadonlyArray<number>, y: ReadonlyArray<number>): (t: number) => number {
  return (t) => {
    if (t <= (x[0] as number)) return y[0] as number;
    for (let k = 1; k < x.length; k++)
      if (t <= (x[k] as number)) {
        const f = (t - (x[k - 1] as number)) / ((x[k] as number) - (x[k - 1] as number));
        return (y[k - 1] as number) + f * ((y[k] as number) - (y[k - 1] as number));
      }
    return y[y.length - 1] as number;
  };
}

/** Cardinal functions of B-spline interpolation through `nodes` (strictly increasing, in 0..1): values[i](t) = 1 at node i, 0 at the others. */
function cardinals(nodes: ReadonlyArray<number>): (t: number) => number[] {
  const n = nodes.length;
  if (n === 1) return () => [1];
  const degree = Math.min(3, n - 1);
  const first = nodes[0] as number;
  const span = (nodes[n - 1] as number) - first;
  const x = nodes.map((node) => (node - first) / span);
  const interior: number[] = [];
  for (let j = 1; j <= n - 1 - degree; j++) {
    let sum = 0;
    for (let i = j; i < j + degree; i++) sum += x[i] as number;
    interior.push(sum / degree);
  }
  const full = [...new Array<number>(degree + 1).fill(0), ...interior, ...new Array<number>(degree + 1).fill(1)];
  const row = (t: number): Array<readonly [number, number]> => {
    const s = findSpan(n, degree, t, full);
    return basisFunctions(s, t, degree, full).map((value, j) => [s - degree + j, value] as const);
  };
  const identity = x.map((_, i) => x.map((__, j) => (i === j ? 1 : 0)));
  const coefficients =
    solveBanded(
      x.map((t) => row(t)),
      identity,
    ) ?? identity;
  return (t) => {
    const clamped = Math.min(1, Math.max(0, (t - first) / span));
    return x.map((_, i) => row(clamped).reduce((sum, [index, value]) => sum + value * ((coefficients[index] as number[])[i] as number), 0));
  };
}

const spread = (nodes: ReadonlyArray<number>, perSpan: number): number[] => {
  const values: number[] = [0];
  const edges = [0, ...nodes.filter((n) => n > 1e-9 && n < 1 - 1e-9), 1];
  for (let k = 1; k < edges.length; k++)
    for (let s = 1; s <= perSpan; s++)
      values.push((edges[k - 1] as number) + (((edges[k] as number) - (edges[k - 1] as number)) * s) / perSpan);
  return values;
};

/**
 * @param sections ordered section curves (>= 2), @param guides curves crossing every section (>= 1), `tolerance` the largest gap between a guide and a section
 * @failure a guide missing a section, or crossings out of order -> SRF_LOFT_GUIDE_MISSES_SECTION; a failing fit -> SRF_NURBS_INVALID
 */
export function gordonSurface(
  sections: ReadonlyArray<NurbsCurveData>,
  guides: ReadonlyArray<NurbsCurveData>,
  tolerance: number,
): GordonResult {
  const [K, J] = [sections.length, guides.length];
  const u: number[][] = []; // u[i][j]: parameter on section i of guide j
  const v: number[][] = []; // v[j][i]: parameter on guide j of section i
  let gap = 0;
  for (let i = 0; i < K; i++) {
    u.push([]);
    for (let j = 0; j < J; j++) {
      const [ta, tb, g] = meet(sections[i] as NurbsCurveData, guides[j] as NurbsCurveData);
      if (g > tolerance)
        return {
          code: 'SRF_LOFT_GUIDE_MISSES_SECTION',
          message: `guide ${j} misses section ${i} by ${g.toExponential(2)} (tolerance ${tolerance})`,
          guide: j,
          section: i,
        };
      gap = Math.max(gap, g);
      (u[i] as number[]).push(ta);
      (v[j] ??= []).push(tb);
    }
  }
  // a collapsed section (a point, e.g. a nose tip) has no meaningful position along itself: it takes the mean of the others
  const collapsed = sections.map((section) => section.poles.every((pole) => distance3(pole, section.poles[0] as Vec3) < 1e-9));
  const live = u.filter((_, i) => !collapsed[i]);
  if (live.length === 0) return { code: 'SRF_NURBS_INVALID', message: 'every section is collapsed to a point' };
  u.forEach((row, i) => {
    if (collapsed[i]) for (let j = 0; j < J; j++) row[j] = live.reduce((sum, other) => sum + (other[j] as number), 0) / live.length;
  });
  const ordered = (list: ReadonlyArray<number>): boolean => list.every((x, k) => k === 0 || x > (list[k - 1] as number) + 1e-9);
  if (!v.every(ordered))
    return {
      code: 'SRF_LOFT_GUIDE_MISSES_SECTION',
      message: 'a guide meets the sections out of order: list the sections along the guides',
    };
  const uBar = Array.from({ length: J }, (_, j) => u.reduce((sum, row) => sum + (row[j] as number), 0) / K);
  if (!ordered(uBar) || !u.every(ordered))
    return {
      code: 'SRF_LOFT_GUIDE_MISSES_SECTION',
      message: 'the guides meet the sections out of order: list the guides across the sections',
    };
  const vBar = Array.from({ length: K }, (_, i) => v.reduce((sum, row) => sum + (row[i] as number), 0) / J);
  const b0 = vBar[0] as number;
  const bSpan = (vBar[K - 1] as number) - b0;
  if (!(bSpan > 1e-9)) return { code: 'SRF_NURBS_INVALID', message: 'the guides do not run across the sections' };
  const vNodes = vBar.map((t) => (t - b0) / bSpan);
  const retimed = (row: ReadonlyArray<number>): ((t: number) => number) => {
    const head = (uBar[0] as number) > 1e-9;
    const tail = (uBar[J - 1] as number) < 1 - 1e-9;
    return piecewise([...(head ? [0] : []), ...uBar, ...(tail ? [1] : [])], [...(head ? [0] : []), ...row, ...(tail ? [1] : [])]);
  };
  const phi = u.map(retimed); // section re-timing
  const psi = v.map((row) =>
    piecewise(
      vNodes,
      row.map((t) => t),
    ),
  ); // guide re-timing (nodes on normalised b)
  const ell = cardinals(vNodes);
  const emm = cardinals(uBar);
  const aValues = spread(uBar, 10);
  const bValues = spread(vNodes, 10);
  const corner = (i: number, j: number): Vec3 => at(sections[i] as NurbsCurveData, u[i]![j]!);
  const grid = aValues.map((a) => {
    const m = emm(a);
    return bValues.map((b): Vec3 => {
      const l = ell(b);
      const p: [number, number, number] = [0, 0, 0];
      const add = (q: Vec3, w: number): void => {
        p[0] += w * q[0];
        p[1] += w * q[1];
        p[2] += w * q[2];
      };
      for (let i = 0; i < K; i++) add(at(sections[i] as NurbsCurveData, (phi[i] as (t: number) => number)(a)), l[i] as number);
      for (let j = 0; j < J; j++) add(at(guides[j] as NurbsCurveData, (psi[j] as (t: number) => number)(b)), m[j] as number);
      for (let i = 0; i < K; i++) for (let j = 0; j < J; j++) add(corner(i, j), -(l[i] as number) * (m[j] as number));
      return p;
    });
  });
  const fit = interpolateGrid(grid, 3, 3);
  if ('code' in fit) return { code: 'SRF_NURBS_INVALID', message: fit.message };
  const probe = surfaceProbe(fit.surface);
  let deviation = 0;
  for (const section of sections)
    for (let s = 0; s <= 12; s++) deviation = Math.max(deviation, closestOnSurface(fit.surface, at(section, s / 12), probe).distance);
  return { surface: fit.surface, deviation, gap };
}
