/**
 * Point drag of a NURBS curve / surface (04 DIR §5.6): the least-norm pole change that moves the point C(u) / S(u, v) by exactly D.
 * Minimise sum |dP|^2 subject to sum R dP = D gives dP = R D / sum R^2, with R the rational basis (w N / sum w N); non-rational: R = N.
 * Weights are unchanged, so the displacement is exact for rational patches too. Poles whose basis function is 0 at the point are untouched.
 */

import type { Vec3 } from '../../model/vectors';
import { basisFunctions, findSpan } from './basis';
import { curveDomain } from './evaluate';
import { expandKnots } from './knotVector';
import { surfaceDomain } from './surface';
import type { NurbsSurfaceData } from './surfaceTypes';
import type { NurbsCurveData } from './types';

/** Rational basis values `R_i` of a curve at `u` as `[firstPole, values]`. */
function curveBasis(curve: NurbsCurveData, u: number): { first: number; values: number[] } {
  const full = expandKnots(curve.knots, curve.multiplicities);
  const span = findSpan(curve.poles.length, curve.degree, u, full);
  const basis = basisFunctions(span, u, curve.degree, full);
  const first = span - curve.degree;
  const weighted = basis.map((value, k) => value * (curve.weights?.[first + k] ?? 1));
  const total = weighted.reduce((sum, value) => sum + value, 0);
  return { first, values: weighted.map((value) => value / total) };
}

/** `curve` with its poles changed so that C(u) moves by `displacement`, or a reason when `u` is outside the domain. */
export function dragCurvePoint(curve: NurbsCurveData, u: number, displacement: Vec3): NurbsCurveData | string {
  const [first, last] = curveDomain(curve);
  if (!(u >= first && u <= last)) return `u ${u} is outside the knot domain [${first}, ${last}]`;
  const { first: start, values } = curveBasis(curve, u);
  const norm = values.reduce((sum, value) => sum + value * value, 0);
  const poles = curve.poles.map((pole, i): Vec3 => {
    const r = values[i - start];
    if (r === undefined || r === 0) return pole;
    const f = r / norm;
    return [pole[0] + f * displacement[0], pole[1] + f * displacement[1], pole[2] + f * displacement[2]];
  });
  return { ...curve, poles };
}

/** `surface` with its poles changed so that S(u, v) moves by `displacement`, or a reason when (u, v) is outside the domain. */
export function dragSurfacePoint(surface: NurbsSurfaceData, u: number, v: number, displacement: Vec3): NurbsSurfaceData | string {
  const [[u0, u1], [v0, v1]] = surfaceDomain(surface);
  if (!(u >= u0 && u <= u1)) return `u ${u} is outside the knot domain [${u0}, ${u1}]`;
  if (!(v >= v0 && v <= v1)) return `v ${v} is outside the knot domain [${v0}, ${v1}]`;
  const fullU = expandKnots(surface.knotsU, surface.multiplicitiesU);
  const fullV = expandKnots(surface.knotsV, surface.multiplicitiesV);
  const countV = (surface.poles[0] as ReadonlyArray<Vec3>).length;
  const spanU = findSpan(surface.poles.length, surface.degreeU, u, fullU);
  const spanV = findSpan(countV, surface.degreeV, v, fullV);
  const nu = basisFunctions(spanU, u, surface.degreeU, fullU);
  const nv = basisFunctions(spanV, v, surface.degreeV, fullV);
  const [i0, j0] = [spanU - surface.degreeU, spanV - surface.degreeV];
  const weight = (i: number, j: number): number => surface.weights?.[i]?.[j] ?? 1;
  let total = 0;
  for (let a = 0; a < nu.length; a++)
    for (let b = 0; b < nv.length; b++) total += (nu[a] as number) * (nv[b] as number) * weight(i0 + a, j0 + b);
  const rational = (i: number, j: number): number => {
    const a = i - i0;
    const b = j - j0;
    if (a < 0 || b < 0 || a >= nu.length || b >= nv.length) return 0;
    return ((nu[a] as number) * (nv[b] as number) * weight(i, j)) / total;
  };
  let norm = 0;
  for (let a = 0; a < nu.length; a++) for (let b = 0; b < nv.length; b++) norm += rational(i0 + a, j0 + b) ** 2;
  const poles = surface.poles.map((row, i) =>
    row.map((pole, j): Vec3 => {
      const r = rational(i, j);
      if (r === 0) return pole;
      const f = r / norm;
      return [pole[0] + f * displacement[0], pole[1] + f * displacement[1], pole[2] + f * displacement[2]];
    }),
  );
  return { ...surface, poles };
}
