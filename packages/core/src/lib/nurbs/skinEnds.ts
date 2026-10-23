/**
 * Skinning with end conditions (SWG M5, D-SWG-2): the v poles of every section pole are interpolated through the sections AND the first (and
 * second) derivative across the first and last section, so a loft leaves a section along a chosen direction (normal, a fixed vector, the tangent
 * plane of a neighbouring face). Derivatives are given per pole; the magnitude is in units of "the distance between the first two sections",
 * so magnitude 1 is the natural speed of a straight blend (two sections with normal ends: a cubic Hermite).
 */

import type { Vec3 } from '../../model/vectors';
import { distance3, len3, scale3 } from '../vec3';
import { basisDerivatives, basisFunctions, findSpan } from './basis';
import { solveBanded, type SparseRow } from './bandSolve';
import { curveDomain } from './evaluate';
import { integrateCurve } from './integrate';
import { compressKnots } from './knotVector';
import { averagedParameters, type FitFailure } from './surfaceFit';
import type { NurbsSurfaceData } from './surfaceTypes';
import type { NurbsCurveData } from './types';

/** What a loft end asks of the surface across the end section. */
export interface EndData {
  /** Unit direction of the v derivative at every pole of the end section. */
  readonly directions: ReadonlyArray<Vec3>;
  /** Speed factor: 1 = the distance between the end section and its neighbour per unit of the chord parameter. */
  readonly magnitude: number;
  /** Optional normal curvature (1/length, signed about `normals`) of the surface across the end at every pole: adds the second derivative. */
  readonly curvature?: { readonly values: ReadonlyArray<number>; readonly normals: ReadonlyArray<Vec3> };
}

/** Centroid of the wire (arc-length weighted mean of its points): the centre of a circle or a symmetric section whatever its parametrisation. */
export function wireCentroid(curve: NurbsCurveData): Vec3 {
  const [first, last] = curveDomain(curve);
  const length = integrateCurve(curve, first, last, (_, d) => len3(d));
  if (!(length > 0)) return curve.poles[0] as Vec3;
  const mean = (axis: 0 | 1 | 2): number => integrateCurve(curve, first, last, (p, d) => (p[axis] as number) * len3(d)) / length;
  return [mean(0), mean(1), mean(2)];
}

/** Row builder of one condition: the basis (or its derivative) at the end of the domain. */
function endRow(poleCount: number, degree: number, u: number, full: ReadonlyArray<number>, order: number): SparseRow {
  const span = findSpan(poleCount, degree, u, full);
  const values = order === 0 ? basisFunctions(span, u, degree, full) : (basisDerivatives(span, u, degree, order, full)[order] as number[]);
  return values.map((value, j) => [span - degree + j, value] as const);
}

/**
 * The patch through compatible `curves` (equal basis; equal weights if rational) with the end derivatives of `start` / `end`.
 * @invariant v is [0, 1] with the sections at the averaged chord parameters; the degree is 3, or 5 when a curvature condition is present
 * @failure fewer than 2 sections, curves that are not compatible, a singular system -> FitFailure
 */
export function skinWithEnds(
  curves: ReadonlyArray<NurbsCurveData>,
  start: EndData | undefined,
  end: EndData | undefined,
  degreeCap = 3,
  given?: ReadonlyArray<number>,
): { surface: NurbsSurfaceData; parameters: number[] } | FitFailure {
  const count = curves.length;
  const first = curves[0] as NurbsCurveData;
  if (count < 2) return { code: 'SRF_POINTS_INSUFFICIENT', message: 'a skin needs at least 2 sections' };
  const poleCount = first.poles.length;
  const rational = first.weights !== undefined;
  const compatible = curves.every(
    (curve) =>
      curve.poles.length === poleCount &&
      curve.degree === first.degree &&
      curve.knots.length === first.knots.length &&
      (curve.weights === undefined) === !rational &&
      (curve.weights ?? []).every((w, i) => Math.abs(w - ((first.weights as number[])[i] as number)) < 1e-9),
  );
  if (!compatible) return { code: 'SRF_NURBS_INVALID', message: 'end conditions need sections on one basis with equal weights' };
  const t =
    given !== undefined
      ? [...given]
      : averagedParameters(
          first.poles.map((_, i) => curves.map((curve) => curve.poles[i] as Vec3)),
          count,
        );
  const withCurvature = [start, end].filter((e) => e?.curvature !== undefined).length;
  const firstDerivatives = [start, end].filter((e) => e !== undefined).length;
  const unknowns = count + firstDerivatives + withCurvature;
  const degree = Math.max(1, Math.min(withCurvature > 0 ? Math.max(5, degreeCap) : degreeCap, unknowns - 1));
  const nodes = [
    t[0] as number,
    ...(start === undefined ? [] : [t[0] as number]),
    ...(start?.curvature === undefined ? [] : [t[0] as number]),
    ...t.slice(1, -1),
    ...(end?.curvature === undefined ? [] : [1]),
    ...(end === undefined ? [] : [1]),
    t[count - 1] as number,
  ];
  const interior: number[] = [];
  for (let j = 1; j <= unknowns - degree - 1; j++) {
    let sum = 0;
    for (let i = j; i < j + degree; i++) sum += nodes[i] as number;
    interior.push(sum / degree);
  }
  const full = [...new Array<number>(degree + 1).fill(0), ...interior, ...new Array<number>(degree + 1).fill(1)];
  const rows: SparseRow[] = [];
  const rhs: number[][] = [];
  const flat = (vectors: ReadonlyArray<Vec3>): number[] => vectors.flatMap((v) => [...v]);
  const speed = (data: EndData, near: NurbsCurveData, far: NurbsCurveData, dt: number): number =>
    (data.magnitude * distance3(wireCentroid(near), wireCentroid(far))) / dt;
  const derivatives = (data: EndData, factor: number): Vec3[] => data.directions.map((d) => scale3(d, factor));
  if (start !== undefined) {
    const factor = speed(start, first, curves[1] as NurbsCurveData, (t[1] as number) - (t[0] as number));
    rows.push(endRow(unknowns, degree, 0, full, 0), endRow(unknowns, degree, 0, full, 1));
    rhs.push(flat(first.poles), flat(derivatives(start, factor)));
    if (start.curvature !== undefined) {
      rows.push(endRow(unknowns, degree, 0, full, 2));
      const c = start.curvature;
      rhs.push(flat(c.normals.map((n, i) => scale3(n, (c.values[i] as number) * factor * factor))));
    }
  } else {
    rows.push(endRow(unknowns, degree, 0, full, 0));
    rhs.push(flat(first.poles));
  }
  for (let k = 1; k < count - 1; k++) {
    const u = t[k] as number;
    const span = findSpan(unknowns, degree, u, full);
    rows.push(basisFunctions(span, u, degree, full).map((value, j) => [span - degree + j, value] as const));
    rhs.push(flat((curves[k] as NurbsCurveData).poles));
  }
  const last = curves[count - 1] as NurbsCurveData;
  if (end !== undefined) {
    const factor = speed(end, last, curves[count - 2] as NurbsCurveData, (t[count - 1] as number) - (t[count - 2] as number));
    if (end.curvature !== undefined) {
      rows.push(endRow(unknowns, degree, 1, full, 2));
      const c = end.curvature;
      rhs.push(flat(c.normals.map((n, i) => scale3(n, (c.values[i] as number) * factor * factor))));
    }
    rows.push(endRow(unknowns, degree, 1, full, 1), endRow(unknowns, degree, 1, full, 0));
    rhs.push(flat(derivatives(end, factor)), flat(last.poles));
  } else {
    rows.push(endRow(unknowns, degree, 1, full, 0));
    rhs.push(flat(last.poles));
  }
  const solved = solveBanded(rows, rhs);
  if (solved === null) return { code: 'SRF_NURBS_INVALID', message: 'the end-condition skinning system is singular (check the sections)' };
  const poles = first.poles.map((_, i) =>
    solved.map((row): Vec3 => [row[3 * i] as number, row[3 * i + 1] as number, row[3 * i + 2] as number]),
  );
  const v = compressKnots(full);
  const surface: NurbsSurfaceData = {
    degreeU: first.degree,
    degreeV: degree,
    poles,
    ...(first.weights === undefined ? {} : { weights: first.weights.map((w) => new Array<number>(unknowns).fill(w)) }),
    knotsU: first.knots,
    multiplicitiesU: first.multiplicities,
    knotsV: v.knots,
    multiplicitiesV: v.multiplicities,
  };
  return { surface, parameters: t };
}
