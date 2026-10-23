/**
 * Swept surface (`sweep_surface`): one B-spline patch whose u direction is the section curve's own basis and whose v direction is the cubic
 * interpolation of every section pole across the path stations. The same evaluator (frames, laws, rails) as the swept solids, no caps.
 * @invariant the section's knots, degree and weights are kept; poles are sweep-local; the reported deviation is the largest distance from the
 *   exact evaluator at cell mid-stations
 */

import { distance3 } from '../../lib/vec3';
import { evaluateCurve } from '../../lib/nurbs/evaluate';
import { evaluateSurface } from '../../lib/nurbs/surface';
import { MAX_SURFACE_POLES, type NurbsSurfaceData } from '../../lib/nurbs/surfaceTypes';
import type { Vec3 } from '../../model/vectors';
import type { NurbsCurveData } from '../../lib/nurbs/types';
import { expandKnots, compressKnots } from '../../lib/nurbs/knotVector';
import { interpolatePolePaths, STATION_DEGREE, type PolePaths } from '../../lib/nurbs/sweepFit';
import type { Vec2 } from '../../model/types';
import type { SweepShape } from './evaluate';
import { placed, stationRuns, type FitRefusal, type Station } from './fitted';

/** Station counts tried in turn (a patch holds at most 400 poles in v: cells + 3). */
const LADDER = [64, 100, 200, 390];
const PROBES = [0.2, 0.5, 0.8];

export interface FittedSurface {
  readonly surface: NurbsSurfaceData;
  readonly cells: number;
  readonly deviation: number;
}

/** The section curve (`poles` are [x, y, 0]) placed at a station, as a world-frame curve. */
function placedCurve(curve: NurbsCurveData, station: Station): NurbsCurveData {
  return { ...curve, poles: curve.poles.map((pole) => placed(station, [pole[0], pole[1]] as Vec2)) };
}

/** One run's cubic pole paths merged after the previous ones into a single C0-joined cubic in v (the joint knot has multiplicity 3). */
function mergeRuns(runs: ReadonlyArray<{ paths: PolePaths; from: number; to: number }>): {
  poles: Vec3[][];
  knots: number[];
  multiplicities: number[];
} {
  const poleCount = (runs[0] as { paths: PolePaths }).paths.poles.length;
  const poles: Vec3[][] = Array.from({ length: poleCount }, () => []);
  const full: number[] = [];
  runs.forEach(({ paths, from, to }, r) => {
    const own = expandKnots(paths.knots, paths.multiplicities).map((k) => from + k * (to - from));
    own.splice(0, r === 0 ? 0 : STATION_DEGREE + 1);
    if (r < runs.length - 1) own.pop();
    full.push(...own);
    paths.poles.forEach((row, i) => (poles[i] as Vec3[]).push(...(r === 0 ? row : row.slice(1))));
  });
  return { poles, ...compressKnots(full) };
}

function fitOnce(shape: SweepShape, curve: NurbsCurveData, cells: number): FittedSurface | FitRefusal {
  const runs = stationRuns(shape, cells);
  if (!Array.isArray(runs)) return runs;
  const fits: Array<{ paths: PolePaths; from: number; to: number }> = [];
  for (const run of runs) {
    const values = Array.from({ length: run.cells + 1 }, (_, k) => placedCurve(curve, run.stations[2 * k] as Station).poles);
    const paths = interpolatePolePaths(values, STATION_DEGREE);
    if (paths === null) return { code: 'SWG_FIT_UNSUPPORTED', message: 'the station interpolation system is singular' };
    fits.push({ paths, from: run.from, to: run.to });
  }
  const merged = mergeRuns(fits);
  const count = merged.poles[0]?.length ?? 0;
  if (count > MAX_SURFACE_POLES)
    return { code: 'SWG_FIT_UNSUPPORTED', message: `the sheet would need ${count} poles across (at most ${MAX_SURFACE_POLES})` };
  const surface: NurbsSurfaceData = {
    degreeU: curve.degree,
    degreeV: STATION_DEGREE,
    poles: merged.poles,
    ...(curve.weights === undefined ? {} : { weights: curve.weights.map((w) => new Array<number>(count).fill(w)) }),
    knotsU: curve.knots,
    multiplicitiesU: curve.multiplicities,
    knotsV: merged.knots,
    multiplicitiesV: merged.multiplicities,
  };
  const first = curve.knots[0] as number;
  const last = curve.knots[curve.knots.length - 1] as number;
  let deviation = 0;
  for (const run of runs) {
    for (let k = 0; k < run.cells; k++) {
      const exact = placedCurve(curve, run.stations[2 * k + 1] as Station);
      const v = run.from + ((run.to - run.from) * (k + 0.5)) / run.cells;
      for (const p of PROBES) {
        const u = first + (last - first) * p;
        deviation = Math.max(deviation, distance3(evaluateSurface(surface, u, v), evaluateCurve(exact, u)));
      }
    }
  }
  return { surface, cells: runs.reduce((sum, run) => sum + run.cells, 0), deviation };
}

/**
 * The swept surface of `curve` (section coordinates) along the sweep `shape`, within `tolerance`.
 * @failure frames / laws / rails that cannot be evaluated -> their code; tolerance not reached with 390 cells -> SWG_FIT_TOLERANCE
 */
export function fitSweepSurface(shape: SweepShape, curve: NurbsCurveData, tolerance: number): FittedSurface | FitRefusal {
  let last = Number.POSITIVE_INFINITY;
  for (const cells of LADDER) {
    const fit = fitOnce(shape, curve, cells);
    if ('code' in fit) return fit;
    last = fit.deviation;
    if (fit.deviation <= tolerance) return fit;
  }
  return {
    code: 'SWG_FIT_TOLERANCE',
    message: `fit deviation ${last.toExponential(2)} exceeds ${tolerance.toExponential(2)} with ${LADDER[LADDER.length - 1]} cells`,
  };
}
