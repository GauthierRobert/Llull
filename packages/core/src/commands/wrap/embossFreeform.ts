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
import { fittedOutline, type Outline } from './footprintOutline';
import { eulerFromAxes } from '../../lib/eulerRotation';
import { cross3, dot3, normalize3, scale3 } from '../../lib/vec3';
import type { ShapeHandle } from '../../geometry/kernel';
import type { FaceQueryPort } from '../../geometry/kernelPorts';
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

const DEPTH_BISECTIONS = 30;

/**
 * Whether a deboss of `depth` along the inward normal passes through the material at any of `points` (surface points of the footprint): the depth at which the thinnest probed place
 * leaves the solid (signed distance of the point at that depth from the solid), or null when every probe stays inside.
 */
export function freeformDepthLimit(input: {
  readonly query: FaceQueryPort;
  readonly shape: ShapeHandle;
  readonly chart: FaceChart;
  readonly orientation: 1 | -1;
  readonly points: readonly Vec3[];
  readonly depth: number;
}): number | null {
  const { query, shape, chart, depth } = input;
  const inward = input.points.map((point) => scale3(chart.normalAt(chart.uvOfPoint(point)), -input.orientation));
  const at = (t: number): Vec3[] =>
    input.points.map((point, k) => [0, 1, 2].map((c) => (point[c] as number) + t * ((inward[k] as Vec3)[c] as number)) as unknown as Vec3);
  const outside = (t: number): boolean[] | null => query.distance(shape, at(t))?.map((hit) => !(hit.signed < 0)) ?? null;
  const deep = outside(depth);
  if (deep === null || !deep.some(Boolean)) return null;
  let best = depth;
  const offenders = deep.flatMap((flag, k) => (flag ? [k] : []));
  for (const k of offenders) {
    let [low, high] = [0, depth];
    for (let step = 0; step < DEPTH_BISECTIONS; step++) {
      const mid = (low + high) / 2;
      const point = [
        (input.points[k] as Vec3)[0] + mid * (inward[k] as Vec3)[0],
        (input.points[k] as Vec3)[1] + mid * (inward[k] as Vec3)[1],
        (input.points[k] as Vec3)[2] + mid * (inward[k] as Vec3)[2],
      ] as Vec3;
      const hit = query.distance(shape, [point])?.[0];
      if (hit !== undefined && hit.signed < 0) low = mid;
      else high = mid;
    }
    best = Math.min(best, low);
  }
  return best;
}

export const isFreeformFailure = (value: FreeformBuild | FreeformFailure): value is FreeformFailure => 'code' in value;

const MAX_SEGMENTS = 2000;
const MIN_COSINE = 0.01;
const COARSE = 33;

interface Coarse {
  readonly uvs: Vec2[];
  readonly points: Vec3[];
}

/** Coarse (u, v) samples of a closed loop of pieces and their 3D images: the folds, the steepness and the heights of the surface. */
function coarseLoop(chart: FaceChart, pieces: readonly PlaneSegment[]): Coarse {
  const uvs = pieces.flatMap((piece) => sampleSegment(piece, COARSE).slice(0, -1));
  return { uvs, points: uvs.map((uv) => chart.pointAt(uv)) };
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
  // the box of the regions in (u, v): the surface can fold over the pull inside a loop whose boundary looks harmless
  const boxUvs = sampled.flatMap((loop) => loop.uvs);
  const [uLow, uHigh] = [Math.min(...boxUvs.map((p) => p[0])), Math.max(...boxUvs.map((p) => p[0]))];
  const [vLow, vHigh] = [Math.min(...boxUvs.map((p) => p[1])), Math.max(...boxUvs.map((p) => p[1]))];
  const boxGrid = Array.from(
    { length: 121 },
    (_, k): Vec2 => [uLow + ((uHigh - uLow) * (k % 11)) / 10, vLow + ((vHigh - vLow) * Math.floor(k / 11)) / 10],
  );
  const cosines = [...boxUvs, ...boxGrid].map((uv) => dot3(scale3(chart.normalAt(uv), input.orientation), e0));
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
  const box = boxGrid.map((uv): Vec3 => chart.pointAt(uv));
  const heights = [...sampled.flatMap((loop) => loop.points), ...box].map((p) => dot3(p, e0));
  const margin = 1e-6 * input.diagonal;
  const extent = depth / cosMin;
  const [low, high] = [Math.min(...heights) - extent - margin, Math.max(...heights) + extent + margin];
  const prismOf = (outline: Outline, tag: string): ShapeRecipe => ({
    op: 'place',
    source: {
      op: 'solid',
      entity: newEntity(
        'extrusion',
        `freeform-${tag}`,
        { profile: outline.profile, depth: high - low, ...(outline.segments === undefined ? {} : { curves: outline.segments }) },
        [0, 0, 0],
        '#cccccc',
      ),
    },
    position: scale3(e0, low),
    rotation: eulerFromAxes(e1, e2, e0),
  });
  const footprints = input.pieces.map((pieces) => fittedOutline((uv) => chart.pointAt(uv), pieces, e1, e2, input.tolerance));
  const segmentCount = footprints.reduce((sum, outline) => sum + (outline.segments?.length ?? outline.profile.length), 0);
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
    let prism = prismOf(footprints[loop++] as Outline, `${region}`);
    for (let hole = 0; hole < holes; hole++)
      prism = { op: 'boolean', boolean: 'subtract', a: prism, b: prismOf(footprints[loop++] as Outline, `${region}.${hole}`) };
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
