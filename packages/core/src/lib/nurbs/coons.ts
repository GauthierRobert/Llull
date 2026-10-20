/** Bilinearly blended Coons patch of four boundary curves, exactly as a NURBS patch (sum of two ruled surfaces minus the bilinear corner patch). */

import type { Vec3 } from '../../model/vectors';
import { curveDomain, evaluateCurve } from './evaluate';
import { commonBasis } from './surfaceEdit';
import { compatibleCurves } from './surfaceFit';
import type { NurbsSurfaceData } from './surfaceTypes';
import type { NurbsCurveData } from './types';

const strip = (a: NurbsCurveData, b: NurbsCurveData, alongU: boolean): NurbsSurfaceData => {
  const rows: Vec3[][] = alongU ? a.poles.map((pole, i) => [pole, b.poles[i] as Vec3]) : [[...a.poles], [...b.poles]];
  return alongU
    ? {
        degreeU: a.degree,
        degreeV: 1,
        poles: rows,
        knotsU: a.knots,
        multiplicitiesU: a.multiplicities,
        knotsV: [0, 1],
        multiplicitiesV: [2, 2],
      }
    : {
        degreeU: 1,
        degreeV: a.degree,
        poles: rows,
        knotsU: [0, 1],
        multiplicitiesU: [2, 2],
        knotsV: a.knots,
        multiplicitiesV: a.multiplicities,
      };
};

/**
 * Patch S(u, v) with S(u, 0) = bottom, S(u, 1) = top, S(0, v) = left, S(1, v) = right. The four curves must be non-rational and their
 * corners must coincide (the caller checks the gaps); opposite curves are made compatible first, so degrees and knots may differ.
 * @failure rational curves or a failing curve edit -> string reason
 */
export function coonsPatch(
  bottom: NurbsCurveData,
  top: NurbsCurveData,
  left: NurbsCurveData,
  right: NurbsCurveData,
): NurbsSurfaceData | string {
  if ([bottom, top, left, right].some((curve) => curve.weights !== undefined)) return 'a Coons patch needs non-rational boundary curves';
  const across = compatibleCurves([bottom, top]);
  if (typeof across === 'string') return across;
  const along = compatibleCurves([left, right]);
  if (typeof along === 'string') return along;
  const corner = (curve: NurbsCurveData, end: 0 | 1): Vec3 => evaluateCurve(curve, curveDomain(curve)[end]);
  const [p00, p10, p01, p11] = [corner(bottom, 0), corner(bottom, 1), corner(top, 0), corner(top, 1)];
  const bilinear: NurbsSurfaceData = {
    degreeU: 1,
    degreeV: 1,
    poles: [
      [p00, p01],
      [p10, p11],
    ],
    knotsU: [0, 1],
    multiplicitiesU: [2, 2],
    knotsV: [0, 1],
    multiplicitiesV: [2, 2],
  };
  const parts = commonBasis([
    strip(across[0] as NurbsCurveData, across[1] as NurbsCurveData, true),
    strip(along[0] as NurbsCurveData, along[1] as NurbsCurveData, false),
    bilinear,
  ]);
  if (typeof parts === 'string') return parts;
  const [ruledU, ruledV, flat] = parts as [NurbsSurfaceData, NurbsSurfaceData, NurbsSurfaceData];
  const poles = ruledU.poles.map((row, i) =>
    row.map((pole, j): Vec3 => {
      const [b, c] = [(ruledV.poles[i] as ReadonlyArray<Vec3>)[j] as Vec3, (flat.poles[i] as ReadonlyArray<Vec3>)[j] as Vec3];
      return [pole[0] + b[0] - c[0], pole[1] + b[1] - c[1], pole[2] + b[2] - c[2]];
    }),
  );
  return { ...ruledU, poles };
}
