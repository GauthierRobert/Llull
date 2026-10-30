/**
 * emboss / deboss on a freeform (B-spline) face (03 WRP M5, spec §14.10): the native `emboss` face-slab op reads plane, cylinder, cone, sphere and torus surfaces only, so
 * the relief of a freeform face is built from exact booleans of recipe nodes instead. The sketch regions are mapped onto the face by the chart as usual; the walls are the
 * lateral surface of the prism of each region along the pull (the outward normal of the solid at the anchor), and the relief is that prism cut to the layer between the
 * face and its exact offset by the depth: emboss = source + prism x (offset(source, +d) - source), deboss = source - prism x (source - offset(source, -d)).
 * @invariant the top of the relief is the exact offset surface of the face (depth measured along the face normal everywhere); the walls are parallel to the pull; the
 *   footprint prism is the region's image projected along the pull, as cubic Bezier / line segments fitted until the deviation is within `tolerance` (reported as footprintDeviation)
 * @failure the pull crossing the face edge-on or both ways over the region, an oversized footprint -> `{ code, message }`
 */

import type { ShapeRecipe, Vec2, Vec3 } from '../../model/types';
import type { FaceChart } from '../../geometry/chartFrame';
import { sampleSegment, type PlaneSegment } from '../../geometry/planeSegments';
import { pointAt2 } from '../../lib/nurbs/curve2d';
import type { CurveSegment } from '../../model/curve';
import { eulerFromAxes } from '../../lib/eulerRotation';
import { cross3, dot3, normalize3, scale3 } from '../../lib/vec3';
import { newEntity } from '../entity/newEntity';

export interface FreeformFailure {
  readonly code: string;
  readonly message: string;
}

export interface FreeformBuild {
  readonly recipe: ShapeRecipe;
  /** Unit pull direction the walls run along (out of the face's material side). */
  readonly pull: Vec3;
  /** Segments (lines and cubic Beziers) of all footprint outlines. */
  readonly footprintSegments: number;
  /** Largest deviation of the fitted footprint outlines from the exact image of the regions, document units. */
  readonly footprintDeviation: number;
}

export const isFreeformFailure = (value: FreeformBuild | FreeformFailure): value is FreeformFailure => 'code' in value;

const MAX_SEGMENTS = 2000;
const MIN_COSINE = 0.01;
const COARSE = 33;
const MAX_SPLIT_DEPTH = 9;
const CHECKS = [0.25, 0.5, 0.75];

interface Coarse {
  readonly uvs: Vec2[];
  readonly points: Vec3[];
}

/** Coarse (u, v) samples of a closed loop of pieces and their 3D images: the folds, the steepness and the heights of the surface. */
function coarseLoop(chart: FaceChart, pieces: readonly PlaneSegment[]): Coarse {
  const uvs = pieces.flatMap((piece) => sampleSegment(piece, COARSE).slice(0, -1));
  return { uvs, points: uvs.map((uv) => chart.pointAt(uv)) };
}

/** The (u, v) point at fraction `s` of a piece. */
function uvOnPiece(piece: PlaneSegment, s: number): Vec2 {
  if (piece.kind === 'line') return [piece.from[0] + s * (piece.to[0] - piece.from[0]), piece.from[1] + s * (piece.to[1] - piece.from[1])];
  const from = piece.curve.knots[0] as number;
  const to = piece.curve.knots[piece.curve.knots.length - 1] as number;
  return pointAt2(piece.curve, from + s * (to - from));
}

interface Footprint {
  readonly segments: CurveSegment<Vec2>[];
  readonly profile: Vec2[];
  readonly deviation: number;
}

const bezierAt = (p: readonly [Vec2, Vec2, Vec2, Vec2], s: number): Vec2 => {
  const [a, b, c, d] = [(1 - s) ** 3, 3 * s * (1 - s) ** 2, 3 * s * s * (1 - s), s ** 3];
  return [a * p[0][0] + b * p[1][0] + c * p[2][0] + d * p[3][0], a * p[0][1] + b * p[1][1] + c * p[2][1] + d * p[3][1]];
};

/**
 * The image of one piece projected along the pull onto the plane (e1, e2), as line and cubic Bezier segments (Hermite ends from the exact tangent), split until the
 * quarter points are within `tolerance` of the image.
 */
function fitPiece(
  chart: FaceChart,
  piece: PlaneSegment,
  e1: Vec3,
  e2: Vec3,
  tolerance: number,
): { segments: CurveSegment<Vec2>[]; deviation: number } {
  const image = (s: number): Vec2 => {
    const p = chart.pointAt(uvOnPiece(piece, s));
    return [dot3(p, e1), dot3(p, e2)];
  };
  const step = 1e-6;
  const slope = (s: number): Vec2 => {
    const [lo, hi] = [Math.max(0, s - step), Math.min(1, s + step)];
    const [a, b] = [image(lo), image(hi)];
    return [(b[0] - a[0]) / (hi - lo), (b[1] - a[1]) / (hi - lo)];
  };
  const segments: CurveSegment<Vec2>[] = [];
  let deviation = 0;
  const fit = (s0: number, s1: number, depth: number): void => {
    const [p0, p1] = [image(s0), image(s1)];
    const h = s1 - s0;
    const [t0, t1] = [slope(s0), slope(s1)];
    const control: readonly [Vec2, Vec2, Vec2, Vec2] = [
      p0,
      [p0[0] + (t0[0] * h) / 3, p0[1] + (t0[1] * h) / 3],
      [p1[0] - (t1[0] * h) / 3, p1[1] - (t1[1] * h) / 3],
      p1,
    ];
    let line = 0;
    let curve = 0;
    for (const q of CHECKS) {
      const truth = image(s0 + q * h);
      const onCurve = bezierAt(control, q);
      curve = Math.max(curve, Math.hypot(truth[0] - onCurve[0], truth[1] - onCurve[1]));
      const chord: Vec2 = [p0[0] + q * (p1[0] - p0[0]), p0[1] + q * (p1[1] - p0[1])];
      line = Math.max(line, Math.hypot(truth[0] - chord[0], truth[1] - chord[1]));
    }
    if (line <= tolerance) {
      deviation = Math.max(deviation, line);
      segments.push({ type: 'line', points: [p0, p1] });
    } else if (curve <= tolerance || depth >= MAX_SPLIT_DEPTH) {
      deviation = Math.max(deviation, curve);
      segments.push({ type: 'bezier', points: control });
    } else {
      fit(s0, s0 + h / 2, depth + 1);
      fit(s0 + h / 2, s1, depth + 1);
    }
  };
  fit(0, 1, 0);
  return { segments, deviation };
}

const tessellated = (segments: readonly CurveSegment<Vec2>[]): Vec2[] =>
  segments.flatMap((segment) =>
    segment.type === 'line'
      ? [segment.points[0]]
      : segment.type === 'bezier'
        ? [0, 0.25, 0.5, 0.75].map((s) => bezierAt(segment.points, s))
        : [],
  );

const signedArea = (polygon: readonly Vec2[]): number =>
  polygon.reduce((sum, p, k) => {
    const next = polygon[(k + 1) % polygon.length] as Vec2;
    return sum + p[0] * next[1] - next[0] * p[1];
  }, 0);

const reversedSegment = (segment: CurveSegment<Vec2>): CurveSegment<Vec2> =>
  segment.type === 'line'
    ? { type: 'line', points: [segment.points[1], segment.points[0]] }
    : ({ type: 'bezier', points: [segment.points[3], segment.points[2], segment.points[1], segment.points[0]] } as CurveSegment<Vec2>);

/** The footprint of one closed loop: counter-clockwise, its segments joined end to start. */
function footprintOf(chart: FaceChart, pieces: readonly PlaneSegment[], e1: Vec3, e2: Vec3, tolerance: number): Footprint {
  const fitted = pieces.map((piece) => fitPiece(chart, piece, e1, e2, tolerance));
  const forward = fitted.flatMap((entry) => entry.segments);
  const counterClockwise = signedArea(tessellated(forward)) >= 0;
  const segments = counterClockwise ? forward : [...forward].reverse().map(reversedSegment);
  return { segments, profile: tessellated(segments), deviation: Math.max(...fitted.map((entry) => entry.deviation)) };
}

/** Offset-layer / pull-prism relief of the mapped `pieces` (one closed loop per outer boundary and hole, regions in order) on `face` of `source`. */
export function buildFreeformRecipe(input: {
  readonly source: ShapeRecipe;
  readonly face: number;
  readonly diagonal: number;
  readonly chart: FaceChart;
  /** +1 when the outward normal of the solid agrees with Su x Sv at the anchor, -1 otherwise. */
  readonly orientation: 1 | -1;
  /** Outward unit normal of the solid at the anchor: the pull. */
  readonly outward: Vec3;
  readonly holesPerRegion: readonly number[];
  readonly pieces: readonly (readonly PlaneSegment[])[];
  readonly mode: 'emboss' | 'deboss';
  readonly depth: number;
  readonly tolerance: number;
}): FreeformBuild | FreeformFailure {
  const { chart, mode, depth } = input;
  const e0 = normalize3(input.outward);
  const sampled = input.pieces.map((pieces) => coarseLoop(chart, pieces));
  const cosines = sampled.flatMap((loop) => loop.uvs.map((uv) => dot3(scale3(chart.normalAt(uv), input.orientation), e0)));
  const cosMin = Math.min(...cosines.map(Math.abs));
  if (cosines.some((c) => c >= MIN_COSINE) && cosines.some((c) => c <= -MIN_COSINE))
    return {
      code: 'WRP_FACE_TOO_STEEP',
      message:
        'the face folds over the region seen along the pull (the outward normal at the anchor): it faces the pull on part of the region and away on another; use a smaller sketch or a flatter anchor',
    };
  if (!(cosMin >= MIN_COSINE))
    return {
      code: 'WRP_FACE_TOO_STEEP',
      message: `the face is ${((Math.asin(Math.min(1, cosMin)) * 180) / Math.PI).toFixed(2)} degrees from the pull at its steepest sample (limit ${((Math.asin(MIN_COSINE) * 180) / Math.PI).toFixed(2)}): walls along the pull would not leave the face; use a smaller sketch or a flatter anchor`,
    };
  const helper: Vec3 = Math.abs(e0[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const e1 = normalize3(cross3(e0, helper));
  const e2 = cross3(e0, e1);
  // heights of the surface over the whole parameter box of the regions (a dome rises between the points of its outline)
  const uvs = sampled.flatMap((loop) => loop.uvs);
  const [uLow, uHigh] = [Math.min(...uvs.map((p) => p[0])), Math.max(...uvs.map((p) => p[0]))];
  const [vLow, vHigh] = [Math.min(...uvs.map((p) => p[1])), Math.max(...uvs.map((p) => p[1]))];
  const box = Array.from(
    { length: 121 },
    (_, k): Vec3 => chart.pointAt([uLow + ((uHigh - uLow) * (k % 11)) / 10, vLow + ((vHigh - vLow) * Math.floor(k / 11)) / 10]),
  );
  const heights = [...sampled.flatMap((loop) => loop.points), ...box].map((p) => dot3(p, e0));
  const margin = 1e-6 * input.diagonal;
  const extent = depth / cosMin;
  const [low, high] = [Math.min(...heights) - extent - margin, Math.max(...heights) + extent + margin];
  const prismOf = (outline: Footprint, tag: string): ShapeRecipe => ({
    op: 'place',
    source: {
      op: 'solid',
      entity: newEntity(
        'extrusion',
        `freeform-${tag}`,
        { profile: outline.profile, depth: high - low, curves: outline.segments },
        [0, 0, 0],
        '#cccccc',
      ),
    },
    position: scale3(e0, low),
    rotation: eulerFromAxes(e1, e2, e0),
  });
  const footprints = input.pieces.map((pieces) => footprintOf(chart, pieces, e1, e2, input.tolerance));
  const segmentCount = footprints.reduce((sum, outline) => sum + outline.segments.length, 0);
  if (segmentCount > MAX_SEGMENTS)
    return {
      code: 'WRP_PARAM_INVALID',
      message: `the footprint outlines have ${segmentCount} segments (limit ${MAX_SEGMENTS}): use a simpler or smaller sketch`,
    };
  const offset: ShapeRecipe = {
    op: 'faceOp',
    source: input.source,
    kind: 'moveFaces',
    faces: [input.face],
    move: { type: 'offset', distance: (mode === 'emboss' ? 1 : -1) * depth },
  };
  const layer: ShapeRecipe =
    mode === 'emboss'
      ? { op: 'boolean', boolean: 'subtract', a: offset, b: input.source }
      : { op: 'boolean', boolean: 'subtract', a: input.source, b: offset };
  const tools: ShapeRecipe[] = [];
  let loop = 0;
  for (const [region, holes] of input.holesPerRegion.entries()) {
    let prism = prismOf(footprints[loop++] as Footprint, `${region}`);
    for (let hole = 0; hole < holes; hole++)
      prism = { op: 'boolean', boolean: 'subtract', a: prism, b: prismOf(footprints[loop++] as Footprint, `${region}.${hole}`) };
    tools.push({ op: 'boolean', boolean: 'intersect', a: prism, b: layer });
  }
  const combined = tools
    .slice(1)
    .reduce<ShapeRecipe>((sum, tool) => ({ op: 'boolean', boolean: 'union', a: sum, b: tool }), tools[0] as ShapeRecipe);
  const recipe: ShapeRecipe =
    mode === 'emboss'
      ? { op: 'boolean', boolean: 'union', a: input.source, b: combined }
      : { op: 'boolean', boolean: 'subtract', a: input.source, b: combined };
  return {
    recipe,
    pull: e0,
    footprintSegments: segmentCount,
    footprintDeviation: Math.max(...footprints.map((outline) => outline.deviation)),
  };
}
