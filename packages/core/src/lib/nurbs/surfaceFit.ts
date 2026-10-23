/**
 * Surface construction by interpolation (Piegl & Tiller §9.2 A9.4, §10.3 A10.3): a patch through a grid of points, and a skinned patch
 * through compatible section curves. Both solve banded collocation systems with chord-length parameters averaged over all rows.
 */

import type { Vec3 } from '../../model/vectors';
import { distance3 } from '../vec3';
import { basisFunctions, findSpan } from './basis';
import { solveBanded, type SparseRow } from './bandSolve';
import { compressKnots } from './knotVector';
import { homogeneousPoles } from './evaluate';
import { evaluateSurface } from './surface';
import { commonBasis, normalizeKnots } from './surfaceEdit';
import { MAX_SURFACE_POLES, type NurbsSurfaceData } from './surfaceTypes';
import type { NurbsCurveData } from './types';

export type FitFailure = {
  readonly code: 'SRF_POINTS_INSUFFICIENT' | 'SRF_POINTS_COINCIDENT' | 'SRF_NURBS_INVALID';
  readonly message: string;
};

/** Chord-length parameters 0..1 of a polyline, or null when it has zero length. */
function chordParameters(points: ReadonlyArray<Vec3>): number[] | null {
  const steps = points.slice(1).map((point, index) => distance3(point, points[index] as Vec3));
  const total = steps.reduce((sum, step) => sum + step, 0);
  if (!(total > 0)) return null;
  const t = [0];
  for (const step of steps) t.push((t[t.length - 1] as number) + step / total);
  t[t.length - 1] = 1;
  return t;
}

/** Mean of the per-row parameter lists (rows with zero length are skipped); uniform when none is usable. */
export function averagedParameters(lists: ReadonlyArray<ReadonlyArray<Vec3>>, count: number): number[] {
  const usable = lists.map(chordParameters).filter((t): t is number[] => t !== null);
  if (usable.length === 0) return Array.from({ length: count }, (_, i) => i / (count - 1));
  return Array.from({ length: count }, (_, k) => usable.reduce((sum, t) => sum + (t[k] as number), 0) / usable.length);
}

/** Clamped knot vector by averaging the parameters (eq. 9.8) for `t.length` poles of `degree`. */
function knotsByAveraging(t: ReadonlyArray<number>, degree: number): number[] {
  const interior: number[] = [];
  for (let j = 1; j <= t.length - 1 - degree; j++) {
    let sum = 0;
    for (let i = j; i < j + degree; i++) sum += t[i] as number;
    interior.push(sum / degree);
  }
  return [...new Array<number>(degree + 1).fill(0), ...interior, ...new Array<number>(degree + 1).fill(1)];
}

/** Collocation matrix of the basis of `full` (degree `degree`, `t.length` poles) at the parameters `t`. */
function collocation(t: ReadonlyArray<number>, degree: number, full: ReadonlyArray<number>): SparseRow[] {
  return t.map((u) => {
    const span = findSpan(t.length, degree, u, full);
    return basisFunctions(span, u, degree, full).map((value, j) => [span - degree + j, value] as const);
  });
}

/** Solves for poles through `values[k]` (vectors of equal length) at parameters `t`; null when singular. */
function solveThrough(
  t: ReadonlyArray<number>,
  degree: number,
  full: ReadonlyArray<number>,
  values: ReadonlyArray<ReadonlyArray<number>>,
): number[][] | null {
  return solveBanded(collocation(t, degree, full), values);
}

/**
 * Patch of the given degrees through the grid `points[i][j]` (i along u, j along v), parameterised by averaged chord lengths.
 * @failure ragged or too small grid (fewer than degree + 1 rows / columns), degree outside 1..5 -> FitFailure
 */
export function interpolateGrid(
  points: ReadonlyArray<ReadonlyArray<Vec3>>,
  degreeU: number,
  degreeV: number,
): { surface: NurbsSurfaceData; residual: number } | FitFailure {
  const [countU, countV] = [points.length, points[0]?.length ?? 0];
  if (!Number.isInteger(degreeU) || !Number.isInteger(degreeV) || degreeU < 1 || degreeV < 1 || degreeU > 5 || degreeV > 5)
    return { code: 'SRF_NURBS_INVALID', message: `degrees must be integers in 1..5 (got ${degreeU}, ${degreeV})` };
  if (points.some((row) => row.length !== countV))
    return { code: 'SRF_POINTS_INSUFFICIENT', message: 'every grid row needs the same number of points' };
  if (countU < degreeU + 1 || countV < degreeV + 1)
    return {
      code: 'SRF_POINTS_INSUFFICIENT',
      message: `a ${degreeU}x${degreeV} patch needs at least ${degreeU + 1} rows of ${degreeV + 1} points (got ${countU} x ${countV})`,
    };
  if (countU > MAX_SURFACE_POLES || countV > MAX_SURFACE_POLES)
    return { code: 'SRF_NURBS_INVALID', message: `at most ${MAX_SURFACE_POLES} points per direction` };
  const uBar = averagedParameters(
    Array.from({ length: countV }, (_, j) => points.map((row) => row[j] as Vec3)),
    countU,
  );
  const vBar = averagedParameters(points, countV);
  const fullU = knotsByAveraging(uBar, degreeU);
  const fullV = knotsByAveraging(vBar, degreeV);
  const alongU = solveThrough(
    uBar,
    degreeU,
    fullU,
    points.map((row) => row.flatMap((p) => [...p])),
  );
  if (alongU === null) return { code: 'SRF_NURBS_INVALID', message: 'the u interpolation system is singular (check the grid)' };
  // alongU[i] = the v-direction data of pole row i: countV vectors of 3
  const alongV = solveThrough(
    vBar,
    degreeV,
    fullV,
    Array.from({ length: countV }, (_, j) =>
      alongU.flatMap((row) => [row[3 * j] as number, row[3 * j + 1] as number, row[3 * j + 2] as number]),
    ),
  );
  if (alongV === null) return { code: 'SRF_NURBS_INVALID', message: 'the v interpolation system is singular (check the grid)' };
  const poles = Array.from({ length: countU }, (_, i) =>
    Array.from(
      { length: countV },
      (_, j) => [(alongV[j] as number[])[3 * i], (alongV[j] as number[])[3 * i + 1], (alongV[j] as number[])[3 * i + 2]] as Vec3,
    ),
  );
  const [u, v] = [compressKnots(fullU), compressKnots(fullV)];
  const surface: NurbsSurfaceData = {
    degreeU,
    degreeV,
    poles,
    knotsU: u.knots,
    multiplicitiesU: u.multiplicities,
    knotsV: v.knots,
    multiplicitiesV: v.multiplicities,
  };
  let residual = 0;
  points.forEach((row, i) =>
    row.forEach((point, j) => {
      residual = Math.max(residual, distance3(evaluateSurface(surface, uBar[i] as number, vBar[j] as number), point));
    }),
  );
  return { surface, residual };
}

/**
 * The curves re-expressed on one basis (common degree, union of the knots, knots normalised to [0, 1]) so that pole i of every curve
 * pairs with pole i of the others.
 * @failure rational mixed with non-rational curves, or an edit failure -> string reason
 */
export function compatibleCurves(curves: ReadonlyArray<NurbsCurveData>): NurbsCurveData[] | string {
  const strips: NurbsSurfaceData[] = curves.map((curve) => ({
    degreeU: curve.degree,
    degreeV: 1,
    poles: curve.poles.map((pole) => [pole, pole]),
    ...(curve.weights === undefined ? {} : { weights: curve.weights.map((weight) => [weight, weight]) }),
    knotsU: curve.knots,
    multiplicitiesU: curve.multiplicities,
    knotsV: [0, 1],
    multiplicitiesV: [2, 2],
  }));
  const common = commonBasis(strips);
  if (typeof common === 'string') return common;
  return common.map((strip) => ({
    degree: strip.degreeU,
    poles: strip.poles.map((row) => row[0] as Vec3),
    ...(strip.weights === undefined ? {} : { weights: strip.weights.map((row) => row[0] as number) }),
    knots: strip.knotsU,
    multiplicities: strip.multiplicitiesU,
  }));
}

/**
 * Patch through the section curves (u along each curve, v across the sections in order): the curves are made compatible, then the v poles
 * are interpolated at averaged chord parameters. Rational sections interpolate in homogeneous coordinates, so conics stay exact.
 * @failure fewer than 2 sections, degreeV outside 1..5 or above sections - 1 -> FitFailure
 */
export function skinCurves(
  curves: ReadonlyArray<NurbsCurveData>,
  degreeV: number,
  parameters?: ReadonlyArray<number>,
): NurbsSurfaceData | FitFailure {
  const count = curves.length;
  if (count < 2) return { code: 'SRF_POINTS_INSUFFICIENT', message: 'a skin needs at least 2 sections' };
  if (!Number.isInteger(degreeV) || degreeV < 1 || degreeV > 5 || degreeV > count - 1)
    return {
      code: 'SRF_NURBS_INVALID',
      message: `degreeV must be an integer in 1..${Math.min(5, count - 1)} for ${count} sections (got ${degreeV})`,
    };
  const compatible = compatibleCurves(curves);
  if (typeof compatible === 'string') return { code: 'SRF_NURBS_INVALID', message: compatible };
  const first = compatible[0] as NurbsCurveData;
  const rational = first.weights !== undefined;
  const vBar =
    parameters ??
    averagedParameters(
      first.poles.map((_, i) => compatible.map((curve) => curve.poles[i] as Vec3)),
      count,
    );
  const fullV = knotsByAveraging(vBar, degreeV);
  const homogeneous = compatible.map((curve) => homogeneousPoles(curve));
  const width = rational ? 4 : 3;
  const solved = solveThrough(
    vBar,
    degreeV,
    fullV,
    homogeneous.map((rows) => rows.flatMap((row) => row.slice(0, width))),
  );
  if (solved === null) return { code: 'SRF_NURBS_INVALID', message: 'the skinning system is singular (check the sections)' };
  const [rowCount, v] = [first.poles.length, compressKnots(fullV)];
  const cell = (i: number, j: number): number[] => (solved[j] as number[]).slice(width * i, width * i + width);
  const poles = Array.from({ length: rowCount }, (_, i) =>
    Array.from({ length: count }, (_, j) => {
      const row = cell(i, j);
      const w = rational ? (row[3] as number) : 1;
      return [(row[0] as number) / w, (row[1] as number) / w, (row[2] as number) / w] as Vec3;
    }),
  );
  const weights = rational
    ? Array.from({ length: rowCount }, (_, i) => Array.from({ length: count }, (_, j) => cell(i, j)[3] as number))
    : undefined;
  return normalizeKnots({
    degreeU: first.degree,
    degreeV,
    poles,
    ...(weights === undefined ? {} : { weights }),
    knotsU: first.knots,
    multiplicitiesU: first.multiplicities,
    knotsV: v.knots,
    multiplicitiesV: v.multiplicities,
  });
}
