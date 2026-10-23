/**
 * Gordon surface through a curve network (sections x guides), built by sampling: S = L_sections + L_guides - T (transfinite union minus
 * the tensor interpolant of the intersection points), with the curves re-timed piecewise-linearly so every guide meets every section at
 * common parameters, then fitted by global interpolation (`interpolateGrid`). The result passes through the network within `deviation`.
 */

import type { Vec3 } from '../../model/vectors';
import { distance3 } from '../vec3';
import { basisFunctions, findSpan } from './basis';
import { solveBanded } from './bandSolve';
import { closestOnSurface, surfaceProbe } from './closest';
import { meetCurves } from './meet';
import { curveDomain, evaluateCurve } from './evaluate';
import { evaluateSurface, surfaceDomain } from './surface';
import { interpolateGrid } from './surfaceFit';
import type { NurbsSurfaceData } from './surfaceTypes';
import type { NurbsCurveData } from './types';

export type GordonResult =
  | {
      readonly surface: NurbsSurfaceData;
      /** Largest distance from sampled section curves to the surface. */
      readonly deviation: number;
      /** Largest distance from the guide curves (between the first and last section) to the surface. */
      readonly guideDeviation: number;
      /** Largest gap between the guide and the section at their crossings. */
      readonly gap: number;
      /** Closed sections: largest distance between the first and last u isoline (0 = closed). */
      readonly seamGap: number;
    }
  | {
      readonly code: 'SRF_LOFT_GUIDE_MISSES_SECTION' | 'SRF_LOFT_GUIDE_NOT_CONTAINED' | 'SRF_NURBS_INVALID';
      readonly message: string;
      readonly guide?: number;
      readonly section?: number;
    };

/** Parameter of `curve` normalised to [0, 1]. */
const at = (curve: NurbsCurveData, t: number): Vec3 => {
  const [a, b] = curveDomain(curve);
  return evaluateCurve(curve, a + (b - a) * t);
};

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

/** Cardinal functions of B-spline interpolation through `nodes` (strictly increasing, in 0..1): values[i](t) = 1 at node i, 0 at the others; null when singular. */
function cardinals(nodes: ReadonlyArray<number>): ((t: number) => number[]) | null {
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
  const coefficients = solveBanded(
    x.map((t) => row(t)),
    identity,
  );
  if (coefficients === null) return null;
  return (t) => {
    const clamped = Math.min(1, Math.max(0, (t - first) / span));
    return x.map((_, i) => row(clamped).reduce((sum, [index, value]) => sum + value * ((coefficients[index] as number[])[i] as number), 0));
  };
}

/**
 * Cardinal functions for nodes on a circle of period 1 (`nodes` increasing within [nodes[0], nodes[0] + 1)): the interpolation runs over
 * the nodes repeated one period either side, and the three copies of each cardinal are summed, so nothing is clamped at the seam.
 */
function periodicCardinals(nodes: ReadonlyArray<number>): ((t: number) => number[]) | null {
  const count = nodes.length;
  if (count === 1) return () => [1];
  const base = cardinals([...nodes.map((n) => n - 1), ...nodes, ...nodes.map((n) => n + 1)]);
  if (base === null) return null;
  const start = nodes[0] as number;
  return (t) => {
    const wrapped = t < start ? t + 1 : t > start + 1 ? t - 1 : t;
    const c = base(wrapped);
    return nodes.map((_, j) => (c[j] as number) + (c[j + count] as number) + (c[j + 2 * count] as number));
  };
}

const spread = (edges: ReadonlyArray<number>, perSpan: number): number[] => {
  const values: number[] = [edges[0] as number];
  for (let k = 1; k < edges.length; k++)
    for (let s = 1; s <= perSpan; s++)
      values.push((edges[k - 1] as number) + (((edges[k] as number) - (edges[k - 1] as number)) * s) / perSpan);
  return values;
};

const wrap01 = (t: number): number => t - Math.floor(t);

/**
 * @param sections ordered section curves (>= 2), @param guides curves crossing every section (>= 1), `tolerance` the largest gap between a guide and a section
 * @invariant closed sections (first pole = last pole, or a collapsed point) are blended periodically, so the first and last u isolines coincide
 * @failure a guide missing a section, or crossings out of order -> SRF_LOFT_GUIDE_MISSES_SECTION; a failing fit -> SRF_NURBS_INVALID
 */
export function gordonSurface(
  sections: ReadonlyArray<NurbsCurveData>,
  givenGuides: ReadonlyArray<NurbsCurveData>,
  tolerance: number,
): GordonResult {
  let guides = givenGuides;
  const [K, J] = [sections.length, guides.length];
  const collapsed = sections.map((section) => section.poles.every((pole) => distance3(pole, section.poles[0] as Vec3) < 1e-9));
  const closed =
    collapsed.some((flag) => !flag) &&
    sections.every((section, i) => {
      const poles = section.poles;
      const size = Math.max(...poles.map((pole) => distance3(pole, poles[0] as Vec3)), 1e-12);
      return collapsed[i] === true || distance3(poles[0] as Vec3, poles[poles.length - 1] as Vec3) < 1e-9 * size;
    });
  const u: number[][] = []; // u[i][j]: parameter on section i of guide j
  const v: number[][] = []; // v[j][i]: parameter on guide j of section i
  let gap = 0;
  for (let i = 0; i < K; i++) {
    u.push([]);
    for (let j = 0; j < J; j++) {
      const [ta, tb, g, again] = meetCurves(sections[i] as NurbsCurveData, guides[j] as NurbsCurveData, tolerance);
      if (again)
        return {
          code: 'SRF_LOFT_GUIDE_MISSES_SECTION',
          message: `guide ${j} meets section ${i} more than once: the crossing is ambiguous`,
          guide: j,
          section: i,
        };
      if (g > tolerance)
        return {
          code: 'SRF_LOFT_GUIDE_MISSES_SECTION',
          message: `guide ${j} misses section ${i} by ${g.toExponential(2)} (tolerance ${tolerance})`,
          guide: j,
          section: i,
        };
      gap = Math.max(gap, g);
      (u[i] as number[]).push(closed && ta > 1 - 1e-9 ? 0 : ta);
      (v[j] ??= []).push(tb);
    }
  }
  // a collapsed section (a point, e.g. a nose tip) has no meaningful position along itself: it takes the mean of the others
  const live = u.filter((_, i) => !collapsed[i]);
  if (live.length === 0) return { code: 'SRF_NURBS_INVALID', message: 'every section is collapsed to a point' };
  u.forEach((row, i) => {
    if (collapsed[i]) for (let j = 0; j < J; j++) row[j] = live.reduce((sum, other) => sum + (other[j] as number), 0) / live.length;
  });
  // guides are blended in the order they cross the sections, whatever order they were given in
  const meanU = (j: number): number => u.reduce((sum, row) => sum + (row[j] as number), 0) / K;
  const order = Array.from({ length: J }, (_, j) => j).sort((a, b) => meanU(a) - meanU(b));
  if (order.some((j, k) => j !== k)) {
    u.forEach((row, i) => (u[i] = order.map((j) => row[j] as number)));
    guides = order.map((j) => guides[j] as NurbsCurveData);
    const reordered = order.map((j) => v[j] as number[]);
    v.splice(0, J, ...reordered);
  }
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
    if (closed)
      return piecewise(
        [...uBar.map((x) => x - 1), ...uBar, ...uBar.map((x) => x + 1)],
        [...row.map((y) => y - 1), ...row, ...row.map((y) => y + 1)],
      );
    const head = (uBar[0] as number) > 1e-9;
    const tail = (uBar[J - 1] as number) < 1 - 1e-9;
    return piecewise([...(head ? [0] : []), ...uBar, ...(tail ? [1] : [])], [...(head ? [0] : []), ...row, ...(tail ? [1] : [])]);
  };
  const phi = u.map(retimed); // section re-timing
  const psi = v.map((row) => piecewise(vNodes, row)); // guide re-timing (nodes on normalised b)
  const ell = cardinals(vNodes);
  const emm = closed ? periodicCardinals(uBar) : cardinals(uBar);
  if (ell === null || emm === null)
    return { code: 'SRF_NURBS_INVALID', message: 'the guide / section nodes are too close together to blend' };
  const aValues = spread(closed ? [...uBar, (uBar[0] as number) + 1] : [0, ...uBar.filter((n) => n > 1e-9 && n < 1 - 1e-9), 1], 10);
  const bValues = spread([0, ...vNodes.filter((n) => n > 1e-9 && n < 1 - 1e-9), 1], 10);
  // everything the blend needs at one a (per row) or one b (per column) is evaluated once
  const corners = u.map((row, i) => row.map((t) => at(sections[i] as NurbsCurveData, t)));
  const sectionRows = aValues.map((a) =>
    sections.map((section, i) => at(section, closed ? wrap01((phi[i] as (t: number) => number)(a)) : (phi[i] as (t: number) => number)(a))),
  );
  const guideColumns = bValues.map((b) => guides.map((guide, j) => at(guide, (psi[j] as (t: number) => number)(b))));
  const leftWeights = bValues.map((b) => ell(b));
  const grid = aValues.map((a, ai) => {
    const m = emm(a);
    return bValues.map((_, bi): Vec3 => {
      const l = leftWeights[bi] as number[];
      const p: [number, number, number] = [0, 0, 0];
      const add = (q: Vec3, w: number): void => {
        p[0] += w * q[0];
        p[1] += w * q[1];
        p[2] += w * q[2];
      };
      for (let i = 0; i < K; i++) add((sectionRows[ai] as Vec3[])[i] as Vec3, l[i] as number);
      for (let j = 0; j < J; j++) add((guideColumns[bi] as Vec3[])[j] as Vec3, m[j] as number);
      for (let i = 0; i < K; i++) for (let j = 0; j < J; j++) add((corners[i] as Vec3[])[j] as Vec3, -(l[i] as number) * (m[j] as number));
      return p;
    });
  });
  const fit = interpolateGrid(grid, 3, 3);
  if ('code' in fit) return { code: 'SRF_NURBS_INVALID', message: fit.message };
  const probe = surfaceProbe(fit.surface);
  let deviation = 0;
  for (const section of sections)
    for (let s = 0; s <= 12; s++) deviation = Math.max(deviation, closestOnSurface(fit.surface, at(section, s / 12), probe).distance);
  let guideDeviation = 0;
  guides.forEach((guide, j) => {
    const [from, to] = [(v[j] as number[])[0] as number, (v[j] as number[])[K - 1] as number];
    for (let s = 0; s <= 40; s++)
      guideDeviation = Math.max(guideDeviation, closestOnSurface(fit.surface, at(guide, from + ((to - from) * s) / 40), probe).distance);
  });
  const [[uMin, uMax], [vMin, vMax]] = surfaceDomain(fit.surface);
  let seamGap = 0;
  if (closed)
    for (let s = 0; s <= 20; s++) {
      const t = vMin + ((vMax - vMin) * s) / 20;
      seamGap = Math.max(seamGap, distance3(evaluateSurface(fit.surface, uMin, t), evaluateSurface(fit.surface, uMax, t)));
    }
  const size = Math.max(
    ...sections.flatMap((section) => section.poles.map((pole) => distance3(pole, sections[0]?.poles[0] as Vec3))),
    1e-9,
  );
  const limit = Math.max(10 * tolerance, 1e-3 * size);
  const worst = Math.max(guideDeviation, seamGap);
  if (worst > limit)
    return {
      code: 'SRF_LOFT_GUIDE_NOT_CONTAINED',
      message: `the fitted surface lies ${worst.toExponential(2)} from a guide or its seam (limit ${limit.toExponential(2)}): use fewer or better aligned guides`,
    };
  return { surface: fit.surface, deviation, guideDeviation, gap, seamGap };
}
