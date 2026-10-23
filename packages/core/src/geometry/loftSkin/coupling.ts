/**
 * Coupling of loft sections (SWG M5/M7): the sections are cut into corresponding segments, each skinned into its own face, so corners stay
 * edges of the solid. `vertices` cuts at the listed curve-parameter fractions; `arc_length` cuts at every corner of any section (at the same arc-length
 * fraction on all sections) and refits the pieces so equal arc-length fractions pair up.
 */

import { curveDerivatives, curveDomain } from '../../lib/nurbs/evaluate';
import { len3 } from '../../lib/vec3';
import { cornerFractions, parameterAtLengthFraction, splitCurve } from '../../lib/nurbs/curveSplit';
import { isClosedCurve, reseamCurve } from '../../lib/nurbs/reseam';
import { arcLengthFit } from '../../lib/nurbs/ruled';
import type { Vec3 } from '../../model/vectors';
import type { NurbsCurveData } from '../../lib/nurbs/types';
import type { LoftIssue, LoftOptions } from './types';

export interface SegmentSet {
  /** `segments[s][k]`: segment s of section k. */
  readonly segments: NurbsCurveData[][];
  /** Largest refit deviation (document units). */
  readonly fitDeviation: number;
}

const mismatch = (message: string): LoftIssue => ({ code: 'SWG_LOFT_COUPLING_MISMATCH', message });

/** Pieces of every section cut at the per-section parameters, transposed to segments across sections. */
function transpose(pieces: NurbsCurveData[][]): NurbsCurveData[][] | LoftIssue {
  const count = pieces[0]?.length ?? 0;
  if (count === 0 || pieces.some((list) => list.length !== count))
    return mismatch('the sections are cut into different numbers of segments');
  return Array.from({ length: count }, (_, s) => pieces.map((list) => list[s] as NurbsCurveData));
}

/** Segments from per-section vertex fractions (the first vertex of a closed section is its seam). */
function byVertices(curves: readonly NurbsCurveData[], pairs: ReadonlyArray<readonly number[]> | undefined): SegmentSet | LoftIssue {
  if (pairs === undefined || pairs.length !== curves.length) return mismatch(`give one vertex list per section (${curves.length})`);
  const length = pairs[0]?.length ?? 0;
  const valid = pairs.every((list) => list.length === length && list.every((f) => Number.isFinite(f) && f >= 0 && f < 1));
  if (length < 1 || !valid) return mismatch('every section needs the same number (>= 1) of vertex fractions in [0, 1)');
  const pieces: NurbsCurveData[][] = [];
  for (const [i, curve] of curves.entries()) {
    const list = pairs[i] as readonly number[];
    const [a, b] = curveDomain(curve);
    let source = curve;
    let cuts = list.map((f) => a + f * (b - a)).filter((u) => u > a + 1e-12);
    if (isClosedCurve(curve)) {
      const seam = a + (list[0] as number) * (b - a);
      const moved = reseamCurve(curve, seam);
      if (typeof moved === 'string') return mismatch(`section ${i}: ${moved}`);
      source = moved;
      const [na, nb] = curveDomain(moved);
      cuts = list.slice(1).map((f) => {
        const u = a + f * (b - a);
        return u < seam ? u + (b - a) : u;
      });
      if (cuts.some((u, k) => !(u > na && u < nb && (k === 0 || u > (cuts[k - 1] as number)))))
        return mismatch(`section ${i}: the vertices must follow the direction of the section (after the first, each further along)`);
    } else if (cuts.some((u, k) => k > 0 && u <= (cuts[k - 1] as number)))
      return mismatch(`section ${i}: the vertex fractions must ascend`);
    const split = splitCurve(source, cuts);
    if (typeof split === 'string') return mismatch(`section ${i}: ${split}`);
    pieces.push(split);
  }
  const segments = transpose(pieces);
  return Array.isArray(segments) ? { segments, fitDeviation: 0 } : segments;
}

/** True when the parametrisation of `curve` is by arc length (constant speed). */
function constantSpeed(curve: NurbsCurveData): boolean {
  const [a, b] = curveDomain(curve);
  const speeds = Array.from({ length: 33 }, (_, k) => len3(curveDerivatives(curve, a + ((b - a) * k) / 32, 1)[1] as Vec3));
  return Math.max(...speeds) - Math.min(...speeds) <= 1e-9 * Math.max(...speeds);
}

/** Segments from the corners of all sections, each piece refitted by arc length. */
function byArcLength(curves: readonly NurbsCurveData[], tolerance: number): SegmentSet | LoftIssue {
  const fractions: number[] = [];
  for (const curve of curves) for (const f of cornerFractions(curve)) if (!fractions.some((g) => Math.abs(g - f) < 1e-6)) fractions.push(f);
  fractions.sort((x, y) => x - y);
  const pieces: NurbsCurveData[][] = [];
  for (const [i, curve] of curves.entries()) {
    const cuts = fractions.map((f) => parameterAtLengthFraction(curve, f));
    const split = splitCurve(curve, cuts);
    if (typeof split === 'string') return mismatch(`section ${i}: ${split}`);
    pieces.push(split);
  }
  const segments = transpose(pieces);
  if (!Array.isArray(segments)) return segments;
  let worst = 0;
  const refit: NurbsCurveData[][] = [];
  for (const segment of segments as NurbsCurveData[][]) {
    const row: NurbsCurveData[] = [];
    for (const piece of segment) {
      if (constantSpeed(piece)) {
        row.push(piece);
        continue;
      }
      const fit = refitByArcLength(piece, tolerance);
      if ('code' in fit) return { code: 'SWG_FIT_TOLERANCE', message: fit.message };
      worst = Math.max(worst, fit.deviation);
      row.push(fit.curve);
    }
    refit.push(row);
  }
  return { segments: refit, fitDeviation: worst };
}

/** `piece` refitted at equal arc-length fractions within `tolerance`. */
function refitByArcLength(
  piece: NurbsCurveData,
  tolerance: number,
): { curve: NurbsCurveData; deviation: number } | { code: string; message: string } {
  let last = Number.POSITIVE_INFINITY;
  for (const count of [8, 16, 32, 64, 128, 256]) {
    const fit = arcLengthFit(piece, count);
    if (typeof fit === 'string') return { code: 'SWG_FIT_TOLERANCE', message: fit };
    last = fit.deviation;
    if (last <= tolerance) return { curve: fit.fit, deviation: last };
  }
  return {
    code: 'SWG_FIT_TOLERANCE',
    message: `the arc-length refit deviates ${last.toExponential(2)} (limit ${tolerance.toExponential(2)})`,
  };
}

/** The sections as corresponding segments (one segment, the whole sections, without coupling). */
export function coupleSections(
  curves: readonly NurbsCurveData[],
  options: Pick<LoftOptions, 'coupling' | 'vertexPairs' | 'fitTolerance'>,
): SegmentSet | LoftIssue {
  if (options.coupling === 'vertices') return byVertices(curves, options.vertexPairs);
  if (options.coupling === 'arc_length') return byArcLength(curves, options.fitTolerance);
  return { segments: [[...curves]], fitDeviation: 0 };
}
