/** Shape-preserving and shape-changing edits of a NURBS curve: knot insertion (A5.1), degree elevation, reversal, pole and weight edits. */

import type { Vec3 } from '../../model/vectors';
import { basisFunctions, findSpan } from './basis';
import { solveBanded, type SparseRow } from './bandSolve';
import { curveDomain, evaluateCurve, homogeneousPoles } from './evaluate';
import { compressKnots, expandKnots, nurbsViolation } from './knotVector';
import { MAX_NURBS_DEGREE, type NurbsCurveData } from './types';

type Edit = NurbsCurveData | string;

const fromHomogeneous = (
  curve: NurbsCurveData,
  rows: ReadonlyArray<ReadonlyArray<number>>,
  full: ReadonlyArray<number>,
  degree: number,
): NurbsCurveData => {
  const rational = curve.weights !== undefined;
  const { knots, multiplicities } = compressKnots(full);
  return {
    degree,
    poles: rows.map((row) => {
      const w = rational ? (row[3] as number) : 1;
      return [(row[0] as number) / w, (row[1] as number) / w, (row[2] as number) / w] as const;
    }),
    ...(rational ? { weights: rows.map((row) => row[3] as number) } : {}),
    knots,
    multiplicities,
  };
};

/**
 * Inserts the knot `u` `times` more times without changing the shape.
 * @failure u not strictly inside the domain, or the resulting multiplicity would exceed the degree -> string reason
 */
export function insertKnot(curve: NurbsCurveData, u: number, times: number): Edit {
  const [first, last] = curveDomain(curve);
  if (!(u > first && u < last)) return `knot ${u} must lie strictly inside the domain (${first}, ${last})`;
  if (!Number.isInteger(times) || times < 1) return `times must be a positive integer (got ${times})`;
  let full = expandKnots(curve.knots, curve.multiplicities);
  const existing = full.filter((knot) => knot === u).length;
  if (existing + times > curve.degree)
    return `inserting ${times} knot(s) at ${u} would give multiplicity ${existing + times} > degree ${curve.degree} (at most ${curve.degree - existing} more)`;
  let poles = homogeneousPoles(curve);
  const p = curve.degree;
  for (let step = 0; step < times; step++) {
    const k = findSpan(poles.length, p, u, full);
    const s = full.filter((knot) => knot === u).length;
    const next: number[][] = [];
    for (let i = 0; i <= poles.length; i++) {
      if (i <= k - p) next.push(poles[i] as number[]);
      else if (i >= k - s + 1) next.push(poles[i - 1] as number[]);
      else {
        const alpha = (u - (full[i] as number)) / ((full[i + p] as number) - (full[i] as number));
        const a = poles[i] as number[];
        const b = poles[i - 1] as number[];
        next.push(a.map((value, c) => alpha * value + (1 - alpha) * (b[c] as number)));
      }
    }
    full = [...full.slice(0, k + 1), u, ...full.slice(k + 1)];
    poles = next;
  }
  return fromHomogeneous(curve, poles, full, p);
}

/**
 * Raises the degree by `by` without changing the shape: every distinct knot gains `by` multiplicity (continuity unchanged) and the poles are
 * solved by collocation of the exact curve at the Greville abscissae of the new knot vector.
 * @failure new degree above the maximum, or `by` < 1 -> string reason
 */
export function elevateDegree(curve: NurbsCurveData, by: number): Edit {
  const degree = curve.degree + by;
  if (!Number.isInteger(by) || by < 1) return `by must be a positive integer (got ${by})`;
  if (degree > MAX_NURBS_DEGREE) return `degree ${curve.degree} + ${by} exceeds the maximum ${MAX_NURBS_DEGREE}`;
  const multiplicities = curve.multiplicities.map((multiplicity) => multiplicity + by);
  const full = expandKnots(curve.knots, multiplicities);
  const count = full.length - degree - 1;
  const homogeneous = homogeneousPoles(curve);
  const { degree: oldDegree, knots, multiplicities: oldMultiplicities } = curve;
  const numerator: NurbsCurveData = {
    degree: oldDegree,
    knots,
    multiplicities: oldMultiplicities,
    poles: homogeneous.map((row) => [row[0] as number, row[1] as number, row[2] as number] as const),
  };
  const weightCurve: NurbsCurveData = {
    degree: oldDegree,
    knots,
    multiplicities: oldMultiplicities,
    poles: homogeneous.map((row) => [row[3] as number, 0, 0] as const),
  };
  const rows: SparseRow[] = [];
  const rhs: number[][] = [];
  for (let i = 0; i < count; i++) {
    let greville = 0;
    for (let j = 1; j <= degree; j++) greville += full[i + j] as number;
    greville /= degree;
    const span = findSpan(count, degree, greville, full);
    rows.push(basisFunctions(span, greville, degree, full).map((value, j) => [span - degree + j, value] as const));
    const [x, y, z] = evaluateCurve(numerator, greville);
    rhs.push([x, y, z, evaluateCurve(weightCurve, greville)[0]]);
  }
  const solved = solveBanded(rows, rhs);
  if (solved === null) return 'degree elevation failed: singular collocation system';
  return fromHomogeneous(curve, solved, full, degree);
}

/** The same curve traversed backwards (domain unchanged). */
export function reverseCurve(curve: NurbsCurveData): NurbsCurveData {
  const [first, last] = curveDomain(curve);
  return {
    degree: curve.degree,
    poles: [...curve.poles].reverse(),
    ...(curve.weights === undefined ? {} : { weights: [...curve.weights].reverse() }),
    knots: [...curve.knots].reverse().map((knot) => first + last - knot),
    multiplicities: [...curve.multiplicities].reverse(),
  };
}

/** `curve` with pole `index` moved to `to`. @failure index out of range -> string reason */
export function movePole(curve: NurbsCurveData, index: number, to: Vec3): Edit {
  if (!Number.isInteger(index) || index < 0 || index >= curve.poles.length)
    return `pole index ${index} is outside 0..${curve.poles.length - 1}`;
  return { ...curve, poles: curve.poles.map((pole, i) => (i === index ? to : pole)) };
}

/** `curve` with the weight of pole `index` set (the curve becomes rational). @failure index out of range or weight <= 0 -> string reason */
export function setWeight(curve: NurbsCurveData, index: number, weight: number): Edit {
  if (!Number.isInteger(index) || index < 0 || index >= curve.poles.length)
    return `pole index ${index} is outside 0..${curve.poles.length - 1}`;
  if (!(Number.isFinite(weight) && weight > 0)) return `weight must be finite and > 0 (got ${weight})`;
  const weights = curve.poles.map((_, i) => (i === index ? weight : (curve.weights?.[i] ?? 1)));
  const edited: NurbsCurveData = { ...curve, weights };
  return nurbsViolation(edited) === null ? edited : 'weight edit produced an invalid curve';
}
