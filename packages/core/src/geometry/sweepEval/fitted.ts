/**
 * Fitted B-spline faces of a sweep (TECHNICAL_SPEC D-SWG-1): one face per section edge, S(u, t) with the edge's own rational basis in u and a
 * cubic interpolation of every edge pole across stations in t. Corners stay B-rep edges; the kernel sews the faces and caps them.
 * @invariant poles are entity-local; adjacent faces share their corner pole paths bit for bit; the reported deviation is the largest distance
 *   between the fitted faces and the exact evaluator at cell mid-stations
 */

import type { SweepEntity, Vec2, Vec3 } from '../../model/types';
import { add3, distance3, scale3 } from '../../lib/vec3';
import { evaluateCurve } from '../../lib/nurbs/evaluate';
import { evaluateSurface } from '../../lib/nurbs/surface';
import type { NurbsSurfaceData } from '../../lib/nurbs/surfaceTypes';
import { interpolatePolePaths, STATION_DEGREE } from '../../lib/nurbs/sweepFit';
import { chainLength, isClosedChain } from '../curveSegments';
import { encodeSurface } from '../surfaceWire';
import { framesAtSamples, pathSamplesAt, type SweepFrame } from './frames';
import { sectionTransforms, transformPoint, twistVariation, type SectionTransform } from './laws';
import { constantEdges, ringEdges, type SectionEdge } from './sectionEdges';
import { stationRingAt } from './sections';

/** Station counts tried in turn; above CHUNK_CELLS a path is cut into faces of CHUNK_CELLS cells (the pole count stays below MAX_SURFACE_POLES). */
const CELL_LADDER = [64, 100, 200, 400, 800, 1600, 3200];
const CHUNK_CELLS = 100;
const CELLS_PER_RADIAN = 24;
/** Section parameters at which the deviation is measured. */
const PROBES = [0.2, 0.5, 0.8];

export interface FittedSweep {
  /** Encoded B-spline surfaces (`encodeSurface`), one per section edge. */
  readonly faces: number[][];
  readonly cells: number;
  /** Largest measured distance between the fitted faces and the exact evaluator (document units). */
  readonly deviation: number;
}

/** A sweep the fitted path cannot or may not realise (the host keeps the mesh). */
export interface FitRefusal {
  readonly code: 'SWG_FIT_TOLERANCE' | 'SWG_FRAME_DEGENERATE' | 'SWG_FIT_UNSUPPORTED';
  readonly message: string;
}

interface Station {
  readonly frame: SweepFrame;
  readonly transform: SectionTransform;
  readonly t: number;
}

function placed(station: Station, p: Vec2): Vec3 {
  const [x, y] = transformPoint(p, station.transform);
  return add3(station.frame.origin ?? station.frame.point, add3(scale3(station.frame.normal, x), scale3(station.frame.binormal, y)));
}

/** Frames and transforms at `2 cells + 1` equally spaced fractions (the odd ones are the deviation probes), or a refusal. */
function stationsOf(sweep: SweepEntity, cells: number): Station[] | FitRefusal {
  const ts = Array.from({ length: 2 * cells + 1 }, (_, k) => k / (2 * cells));
  const frames = framesAtSamples(pathSamplesAt(sweep.path, ts, sweep.helix), sweep.orientation);
  if (!Array.isArray(frames)) return { code: 'SWG_FRAME_DEGENERATE', message: frames.message };
  const length = chainLength(sweep.path);
  const transforms = sectionTransforms(sweep, ts, length);
  return ts.map((t, k) => ({ t, frame: frames[k] as SweepFrame, transform: transforms[k] as SectionTransform }));
}

/** Edges at fraction `t` (constant sections are the same everywhere). */
function edgesAt(sweep: SweepEntity, constant: SectionEdge[] | null, t: number): SectionEdge[] {
  if (constant !== null) return constant;
  return ringEdges(stationRingAt(sweep.stations ?? [], t, sweep.stationBlend));
}

function curveOf(edge: SectionEdge, station: Station): Parameters<typeof evaluateCurve>[0] {
  return {
    degree: edge.degree,
    poles: edge.poles.map((p) => placed(station, p)),
    ...(edge.weights === undefined ? {} : { weights: edge.weights }),
    knots: [0, 1],
    multiplicities: [edge.degree + 1, edge.degree + 1],
  };
}

/** One face: the pole paths of edge `e` across the stations `first..first + width` of `even`, with the deviation measured at the cell mid-stations. */
function chunkFace(
  sweep: SweepEntity,
  constant: SectionEdge[] | null,
  stations: readonly Station[],
  edgesByStation: ReadonlyArray<SectionEdge[]>,
  e: number,
  first: number,
  width: number,
): { face: NurbsSurfaceData; deviation: number } | null {
  const edge0 = (edgesByStation[first] as SectionEdge[])[e] as SectionEdge;
  const values: Vec3[][] = [];
  for (let k = first; k <= first + width; k++) {
    const station = stations[2 * k] as Station;
    values.push(((edgesByStation[k] as SectionEdge[])[e] as SectionEdge).poles.map((p) => placed(station, p)));
  }
  const fit = interpolatePolePaths(values, STATION_DEGREE);
  if (fit === null) return null;
  const count = fit.poles[0]?.length ?? 0;
  const face: NurbsSurfaceData = {
    degreeU: edge0.degree,
    degreeV: STATION_DEGREE,
    poles: fit.poles,
    ...(edge0.weights === undefined ? {} : { weights: edge0.weights.map((w) => new Array<number>(count).fill(w)) }),
    knotsU: [0, 1],
    multiplicitiesU: [edge0.degree + 1, edge0.degree + 1],
    knotsV: fit.knots,
    multiplicitiesV: fit.multiplicities,
  };
  let deviation = 0;
  for (let k = 0; k < width; k++) {
    const probe = stations[2 * (first + k) + 1] as Station;
    const exact = curveOf(edgesAt(sweep, constant, probe.t)[e] as SectionEdge, probe);
    for (const u of PROBES)
      deviation = Math.max(deviation, distance3(evaluateSurface(face, u, (k + 0.5) / width), evaluateCurve(exact, u)));
  }
  return { face, deviation };
}

function fitOnce(
  sweep: SweepEntity,
  constant: SectionEdge[] | null,
  cells: number,
): { faces: NurbsSurfaceData[]; deviation: number } | FitRefusal {
  const stations = stationsOf(sweep, cells);
  if (!Array.isArray(stations)) return stations;
  const edgesByStation = Array.from({ length: cells + 1 }, (_, k) => edgesAt(sweep, constant, (stations[2 * k] as Station).t));
  const edgeCount = (edgesByStation[0] as SectionEdge[]).length;
  const width = Math.min(cells, CHUNK_CELLS);
  const faces: NurbsSurfaceData[] = [];
  let deviation = 0;
  for (let e = 0; e < edgeCount; e++)
    for (let first = 0; first < cells; first += width) {
      const made = chunkFace(sweep, constant, stations, edgesByStation, e, first, width);
      if (made === null) return { code: 'SWG_FIT_UNSUPPORTED', message: 'the station interpolation system is singular' };
      faces.push(made.face);
      deviation = Math.max(deviation, made.deviation);
    }
  return { faces, deviation };
}

function modelSize(sweep: SweepEntity): number {
  const section =
    sweep.section.shape === 'circle' ? sweep.section.radius : Math.max(...sweep.section.profile.map(([x, y]) => Math.hypot(x, y)));
  const poles = sweep.path.flatMap((segment) => segment.points);
  const extent = [0, 1, 2].map(
    (axis) => Math.max(...poles.map((p) => p[axis] as number)) - Math.min(...poles.map((p) => p[axis] as number)),
  );
  return Math.hypot(...extent) + 2 * section;
}

/** Named default fit tolerance: 1e-7 of the model size (path poles plus section), at least 1e-9 document units: the volume then holds ~1e-6. */
export function fitToleranceOf(sweep: SweepEntity): number {
  return Math.max(1e-9, 1e-7 * modelSize(sweep));
}

/** Sewing tolerance of the exact faces: 1e-6 of the model size (the edges of OCC's B-spline faces agree to about 1e-5 of their size), at least 1e-7. */
export function sewToleranceOf(sweep: SweepEntity): number {
  return Math.max(1e-7, 1e-6 * modelSize(sweep));
}

/**
 * Fitted faces of `sweep` within `tolerance`, refining the station count (64 up to 3200 cells, cut into faces of 100 cells) until the probes agree.
 * @failure closed path, hollow circle, degenerate arc -> SWG_FIT_UNSUPPORTED; frame mode degenerate -> SWG_FRAME_DEGENERATE;
 *   tolerance not reached with 3200 cells -> SWG_FIT_TOLERANCE
 */
export function fitSweepFaces(sweep: SweepEntity, tolerance: number): FittedSweep | FitRefusal {
  if (isClosedChain(sweep.path))
    return { code: 'SWG_FIT_UNSUPPORTED', message: 'laws and frame modes on a closed path are realised as a mesh' };
  const constant = sweep.stations === undefined ? constantEdges(sweep.section) : null;
  if (sweep.stations === undefined && constant === null)
    return { code: 'SWG_FIT_UNSUPPORTED', message: 'a hollow round section or a degenerate arc is realised as a mesh' };
  const wanted = Math.ceil(CELLS_PER_RADIAN * twistVariation(sweep, chainLength(sweep.path)));
  let last = Number.POSITIVE_INFINITY;
  for (const cells of CELL_LADDER.filter((n) => n >= wanted || n === CELL_LADDER[CELL_LADDER.length - 1])) {
    const fit = fitOnce(sweep, constant, cells);
    if ('code' in fit) return fit;
    last = fit.deviation;
    if (fit.deviation <= tolerance) return { faces: fit.faces.map(encodeSurface), cells, deviation: fit.deviation };
  }
  return {
    code: 'SWG_FIT_TOLERANCE',
    message: `fit deviation ${last.toExponential(2)} exceeds ${tolerance.toExponential(2)} with ${CELL_LADDER[CELL_LADDER.length - 1]} cells`,
  };
}
