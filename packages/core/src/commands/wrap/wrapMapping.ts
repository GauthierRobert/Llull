/**
 * A sketch outline through the face chart (03 WRP): curves with their pcurves and 3D images for `wrap_to_face`, regions of (u, v) loops for `emboss_on_face`,
 * and the placement checks both share (wrap-around overlap, loops leaving the trimmed face).
 */

import type { NurbsCurve2Data } from '../../lib/nurbs/curve2d';
import type { NurbsCurveData } from '../../lib/nurbs/types';
import type { Vec2, Vec3 } from '../../model/vectors';
import { segmentEnd, segmentLength, segmentStart, type PlaneSegment } from '../../geometry/planeSegments';
import { curve3d, extentOf, isMappingError, lengthOnFace, mapPieces, pcurveOf } from '../../geometry/wrapCurves';
import type { FaceChart } from '../../geometry/chartFrame';
import type { UvLoop, UvRegion } from '../../model/wrap';
import type { ChartRegion, SketchOutline } from './sketchProfiles';
import type { FaceSession } from './faceSession';

/** One outline mapped onto the face. */
export interface MappedCurve {
  readonly sourceId: string;
  readonly role: 'outer' | 'hole' | 'open';
  readonly pieces: readonly PlaneSegment[];
  readonly curve: NurbsCurveData;
  readonly pcurve: NurbsCurve2Data;
  /** Largest deviation of the 3D curve from the exact image (document units); 0 when exact. */
  readonly fitTolerance: number;
  readonly chartLength: number;
  readonly length3d: number;
  readonly closed: boolean;
}

export interface MappingFailure {
  readonly code: string;
  readonly message: string;
  readonly ids: readonly string[];
}

export const isMappingFailure = (value: unknown): value is MappingFailure =>
  typeof value === 'object' && value !== null && 'code' in value && 'message' in value && !('pieces' in value);

/** The chain with each piece starting exactly where the previous one ends (a closed chain also ends on its start). */
function snapped(pieces: readonly PlaneSegment[], closed: boolean): PlaneSegment[] {
  const out = pieces.map((piece) => piece);
  const joinStart = (piece: PlaneSegment, at: Vec2): PlaneSegment =>
    piece.kind === 'line'
      ? { kind: 'line', from: at, to: piece.to }
      : { kind: 'nurbs', curve: { ...piece.curve, poles: [at, ...piece.curve.poles.slice(1)] } };
  const joinEnd = (piece: PlaneSegment, at: Vec2): PlaneSegment =>
    piece.kind === 'line'
      ? { kind: 'line', from: piece.from, to: at }
      : { kind: 'nurbs', curve: { ...piece.curve, poles: [...piece.curve.poles.slice(0, -1), at] } };
  for (let k = 1; k < out.length; k++) out[k] = joinStart(out[k] as PlaneSegment, segmentEnd(out[k - 1] as PlaneSegment));
  if (closed && out.length > 0) out[out.length - 1] = joinEnd(out[out.length - 1] as PlaneSegment, segmentStart(out[0] as PlaneSegment));
  return out;
}

/** The recipe form of a closed chain of (u, v) pieces. */
export function uvLoopOf(pieces: readonly PlaneSegment[]): UvLoop {
  const chain = snapped(pieces, true);
  return {
    start: segmentStart(chain[0] as PlaneSegment),
    segments: chain.map((piece) =>
      piece.kind === 'line' ? { kind: 'line' as const, to: piece.to } : { kind: 'nurbs' as const, curve: piece.curve },
    ),
  };
}

function mapChain(
  session: FaceSession,
  chart: FaceChart,
  chain: readonly PlaneSegment[],
  tolerance: number,
): PlaneSegment[] | MappingFailure {
  const mapped = mapPieces(chart, chain, tolerance);
  return isMappingError(mapped) ? { code: 'WRP_OUTSIDE_FACE', message: mapped.error, ids: [session.entity.id] } : mapped;
}

/** Every loop and open chain of `outline` as a curve on the face. @failure a chart or fit failure -> MappingFailure */
export function mapOutlineCurves(
  session: FaceSession,
  chart: FaceChart,
  outline: SketchOutline,
  tolerance: number,
): MappedCurve[] | MappingFailure {
  const jobs: Array<{ chain: readonly PlaneSegment[]; role: MappedCurve['role'] }> = [
    ...outline.regions.flatMap((region) => [
      { chain: region.outer, role: 'outer' as const },
      ...region.holes.map((hole) => ({ chain: hole, role: 'hole' as const })),
    ]),
    ...outline.open.map((chain) => ({ chain, role: 'open' as const })),
  ];
  const out: MappedCurve[] = [];
  for (const { chain, role } of jobs) {
    const mapped = mapChain(session, chart, chain, tolerance);
    if (isMappingFailure(mapped)) return mapped;
    const pieces = snapped(mapped, role !== 'open');
    const image = curve3d(chart, pieces, tolerance);
    if (isMappingError(image)) return { code: 'WRP_OUTSIDE_FACE', message: image.error, ids: [session.entity.id] };
    const pcurve = pcurveOf(pieces, tolerance / chart.metricBound(0));
    if (isMappingError(pcurve)) return { code: 'WRP_OUTSIDE_FACE', message: pcurve.error, ids: [session.entity.id] };
    out.push({
      sourceId: outline.id,
      role,
      pieces,
      curve: image.curve,
      pcurve,
      fitTolerance: image.deviation,
      chartLength: chain.reduce((sum, piece) => sum + segmentLength(piece), 0),
      length3d: lengthOnFace(chart, pieces),
      closed: role !== 'open',
    });
  }
  return out;
}

/** The regions of `outline` as recipe regions of (u, v) loops. @failure a chart or fit failure -> MappingFailure */
export function mapOutlineRegions(
  session: FaceSession,
  chart: FaceChart,
  regions: readonly ChartRegion[],
  tolerance: number,
): { regions: UvRegion[]; pieces: PlaneSegment[][] } | MappingFailure {
  const out: UvRegion[] = [];
  const all: PlaneSegment[][] = [];
  for (const region of regions) {
    const loops: UvLoop[] = [];
    for (const chain of [region.outer, ...region.holes]) {
      const mapped = mapChain(session, chart, chain, tolerance);
      if (isMappingFailure(mapped)) return mapped;
      all.push(snapped(mapped, true));
      loops.push(uvLoopOf(mapped));
    }
    out.push({ outer: loops[0] as UvLoop, holes: loops.slice(1) });
  }
  return { regions: out, pieces: all };
}

/**
 * Wrap-around check: the (u) extent of the mapped pieces may not exceed one turn.
 * @failure extent > 2 pi (1 + 1e-9) -> MappingFailure WRP_WRAP_OVERLAP
 */
export function checkWrapAround(
  chart: FaceChart,
  pieces: readonly (readonly PlaneSegment[])[],
  ids: readonly string[],
): MappingFailure | null {
  if (chart.kind === 'plane' || pieces.length === 0) return null;
  const boxes = pieces.map((chain) => extentOf(chain));
  const extent = Math.max(...boxes.map((box) => box.max[0])) - Math.min(...boxes.map((box) => box.min[0]));
  if (extent <= 2 * Math.PI * (1 + 1e-9)) return null;
  return {
    code: 'WRP_WRAP_OVERLAP',
    message: `the sketch spans ${((extent * (chart.fullWrapWidth ?? 0)) / (2 * Math.PI)).toPrecision(8)} around the face but one full turn is ${(chart.fullWrapWidth ?? 0).toPrecision(8)} (data.fullWrapChartWidth)`,
    ids,
  };
}

/** Probe points of the mapped pieces for the trimmed-face test: a few per loop, at most `limit` in all. */
export function probePoints(chart: FaceChart, loops: readonly (readonly PlaneSegment[])[], limit: number): Vec3[] {
  const perLoop = Math.max(1, Math.min(4, Math.floor(limit / Math.max(1, loops.length))));
  const stride = Math.max(1, Math.ceil(loops.length / limit));
  const points: Vec3[] = [];
  for (let l = 0; l < loops.length && points.length < limit; l += stride) {
    const chain = loops[l] as readonly PlaneSegment[];
    for (let k = 0; k < perLoop; k++)
      points.push(chart.pointAt(segmentStart(chain[Math.floor((k * chain.length) / perLoop)] as PlaneSegment)));
  }
  return points;
}

/**
 * Trimmed-face check: every probe point must lie on the picked face (`faceContains`).
 * @failure a probe point outside the face -> MappingFailure WRP_OUTSIDE_FACE
 */
export function checkOnFace(session: FaceSession, points: readonly Vec3[], ids: readonly string[]): MappingFailure | null {
  const tolerance = 1e-6 * session.diagonal + 1e-9;
  for (const [index, point] of points.entries()) {
    const inside = session.query.faceContains(session.shape, session.face, point, tolerance);
    if (inside === false) {
      return {
        code: 'WRP_OUTSIDE_FACE',
        message: `the sketch leaves the face: probe point ${index} [${point.map((v) => v.toPrecision(6)).join(', ')}] is outside face ${session.face}`,
        ids,
      };
    }
  }
  return null;
}
