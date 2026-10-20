/** Point, derivative and iso-curve evaluation of a NURBS surface (Piegl & Tiller A3.6 / A4.4 / §4.5). */

import type { Vec3 } from '../../model/vectors';
import { basisDerivatives, basisFunctions, findSpan } from './basis';
import { expandKnots } from './knotVector';
import type { NurbsCurveData } from './types';
import type { NurbsSurfaceData } from './surfaceTypes';

const fullKnotCache = new WeakMap<NurbsSurfaceData, { u: number[]; v: number[] }>();

function fullKnots(surface: NurbsSurfaceData): { u: number[]; v: number[] } {
  const cached = fullKnotCache.get(surface);
  if (cached !== undefined) return cached;
  const full = { u: expandKnots(surface.knotsU, surface.multiplicitiesU), v: expandKnots(surface.knotsV, surface.multiplicitiesV) };
  fullKnotCache.set(surface, full);
  return full;
}

/** Parameter rectangle `[[uMin, uMax], [vMin, vMax]]`. */
export function surfaceDomain(surface: NurbsSurfaceData): readonly [readonly [number, number], readonly [number, number]] {
  return [
    [surface.knotsU[0] as number, surface.knotsU[surface.knotsU.length - 1] as number],
    [surface.knotsV[0] as number, surface.knotsV[surface.knotsV.length - 1] as number],
  ];
}

/** Homogeneous pole `[w x, w y, w z, w]` of pole (i, j); weight 1 when non-rational. */
function homogeneous(surface: NurbsSurfaceData, i: number, j: number): number[] {
  const pole = (surface.poles[i] as ReadonlyArray<Vec3>)[j] as Vec3;
  const w = surface.weights === undefined ? 1 : ((surface.weights[i] as ReadonlyArray<number>)[j] as number);
  return [pole[0] * w, pole[1] * w, pole[2] * w, w];
}

const BINOMIAL: number[][] = [[1], [1, 1], [1, 2, 1], [1, 3, 3, 1], [1, 4, 6, 4, 1]];

const binomial = (n: number, k: number): number => (BINOMIAL[n] as number[])[k] as number;

/**
 * Surface point and partial derivatives up to total order `order` (<= 4) at (u, v), clamped to the domain: `result[k][l]` is
 * d^(k+l) S / du^k dv^l for k + l <= order.
 */
export function surfaceDerivatives(surface: NurbsSurfaceData, u: number, v: number, order: number): Vec3[][] {
  const [[u0, u1], [v0, v1]] = surfaceDomain(surface);
  const [tu, tv] = [Math.min(u1, Math.max(u0, u)), Math.min(v1, Math.max(v0, v))];
  const full = fullKnots(surface);
  const [p, q] = [surface.degreeU, surface.degreeV];
  const spanU = findSpan(surface.poles.length, p, tu, full.u);
  const spanV = findSpan((surface.poles[0] as ReadonlyArray<Vec3>).length, q, tv, full.v);
  const nu = basisDerivatives(spanU, tu, p, order, full.u);
  const nv = basisDerivatives(spanV, tv, q, order, full.v);
  const patch: number[][][] = Array.from({ length: p + 1 }, (_, a) =>
    Array.from({ length: q + 1 }, (_, b) => homogeneous(surface, spanU - p + a, spanV - q + b)),
  );
  // A[k][l] = homogeneous derivative (4 components)
  const homogeneousDerivatives: number[][][] = [];
  for (let k = 0; k <= order; k++) {
    const row: number[][] = [];
    for (let l = 0; l <= order - k; l++) {
      const sum = [0, 0, 0, 0];
      for (let a = 0; a <= p; a++)
        for (let b = 0; b <= q; b++) {
          const factor = ((nu[k] as number[])[a] as number) * ((nv[l] as number[])[b] as number);
          if (factor === 0) continue;
          const pole = (patch[a] as number[][])[b] as number[];
          for (let c = 0; c < 4; c++) sum[c] = (sum[c] as number) + factor * (pole[c] as number);
        }
      row.push(sum);
    }
    homogeneousDerivatives.push(row);
  }
  const at = (k: number, l: number): number[] => (homogeneousDerivatives[k] as number[][])[l] as number[];
  if (surface.weights === undefined) return homogeneousDerivatives.map((row) => row.map((entry) => [entry[0], entry[1], entry[2]] as Vec3));
  const w00 = (at(0, 0) as number[])[3] as number;
  const result: number[][][] = [];
  for (let k = 0; k <= order; k++) {
    const row: number[][] = [];
    for (let l = 0; l <= order - k; l++) {
      const value = [at(k, l)[0] as number, at(k, l)[1] as number, at(k, l)[2] as number];
      for (let j = 1; j <= l; j++) {
        const [wj, previous] = [at(0, j)[3] as number, row[l - j] as number[]];
        for (let c = 0; c < 3; c++) value[c] = (value[c] as number) - binomial(l, j) * wj * (previous[c] as number);
      }
      for (let i = 1; i <= k; i++) {
        const [wi, previous] = [at(i, 0)[3] as number, (result[k - i] as number[][])[l] as number[]];
        for (let c = 0; c < 3; c++) value[c] = (value[c] as number) - binomial(k, i) * wi * (previous[c] as number);
        const inner = [0, 0, 0];
        for (let j = 1; j <= l; j++) {
          const [wij, prior] = [at(i, j)[3] as number, (result[k - i] as number[][])[l - j] as number[]];
          for (let c = 0; c < 3; c++) inner[c] = (inner[c] as number) + binomial(l, j) * wij * (prior[c] as number);
        }
        for (let c = 0; c < 3; c++) value[c] = (value[c] as number) - binomial(k, i) * (inner[c] as number);
      }
      row.push(value.map((component) => component / w00));
    }
    result.push(row);
  }
  return result.map((row) => row.map((entry) => [entry[0], entry[1], entry[2]] as Vec3));
}

/** Point on the surface at (u, v). */
export function evaluateSurface(surface: NurbsSurfaceData, u: number, v: number): Vec3 {
  return (surfaceDerivatives(surface, u, v, 0)[0] as Vec3[])[0] as Vec3;
}

/**
 * The curve of constant `u` (direction 'u': a curve in v) or constant `v` (a curve in u), exact: its poles are the basis-weighted
 * combination of the pole rows, so no knot insertion is needed.
 */
export function isoCurve(surface: NurbsSurfaceData, direction: 'u' | 'v', parameter: number): NurbsCurveData {
  const full = fullKnots(surface);
  const fixedU = direction === 'u';
  const [degree, fixedKnots, fixedCount] = fixedU
    ? [surface.degreeU, full.u, surface.poles.length]
    : [surface.degreeV, full.v, (surface.poles[0] as ReadonlyArray<Vec3>).length];
  const domain = surfaceDomain(surface)[fixedU ? 0 : 1];
  const t = Math.min(domain[1], Math.max(domain[0], parameter));
  const span = findSpan(fixedCount, degree, t, fixedKnots);
  const basis = basisFunctions(span, t, degree, fixedKnots);
  const along = fixedU ? (surface.poles[0] as ReadonlyArray<Vec3>).length : surface.poles.length;
  const homogeneousPoles: number[][] = [];
  for (let k = 0; k < along; k++) {
    const sum = [0, 0, 0, 0];
    for (let a = 0; a <= degree; a++) {
      const index = span - degree + a;
      const pole = fixedU ? homogeneous(surface, index, k) : homogeneous(surface, k, index);
      for (let c = 0; c < 4; c++) sum[c] = (sum[c] as number) + (basis[a] as number) * (pole[c] as number);
    }
    homogeneousPoles.push(sum);
  }
  const rational = surface.weights !== undefined;
  const [knots, multiplicities, curveDegree] = fixedU
    ? [surface.knotsV, surface.multiplicitiesV, surface.degreeV]
    : [surface.knotsU, surface.multiplicitiesU, surface.degreeU];
  return {
    degree: curveDegree,
    poles: homogeneousPoles.map((row) => {
      const w = rational ? (row[3] as number) : 1;
      return [(row[0] as number) / w, (row[1] as number) / w, (row[2] as number) / w] as Vec3;
    }),
    ...(rational ? { weights: homogeneousPoles.map((row) => row[3] as number) } : {}),
    knots: [...knots],
    multiplicities: [...multiplicities],
  };
}

/** Applies `map` to every pole (an affine placement keeps the patch exactly NURBS). */
export function mapSurfacePoles(surface: NurbsSurfaceData, map: (pole: Vec3) => Vec3): NurbsSurfaceData {
  return { ...surface, poles: surface.poles.map((row) => row.map(map)) };
}
