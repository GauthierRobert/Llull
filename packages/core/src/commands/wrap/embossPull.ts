/**
 * emboss_on_face with walls along a pull direction (03 WRP M5, VC-WRP-25 / 26): the mould-friendly form of the relief. The sketch regions are mapped onto the face as usual; the
 * walls are then the lateral surface of the prism of each region along the pull, and the relief is that prism cut to the layer between the face and its offset by the depth:
 * emboss = source + (prism x (offset(source, +d) - source)), deboss = source - (prism x (source - offset(source, -d))), all exact kernel booleans of recipe nodes (`faceOp`
 * moveFaces offset for the layer). A draft tilts the walls of the relief about the plane through the anchor perpendicular to the feature axis (native BRepOffsetAPI_DraftAngle).
 * @invariant walls are parallel to the pull (a draft of 0) or tilted by exactly the draft; the footprint prism is the region projected along the pull (polygonal where the
 *   region's image is curved: data.exact is false then, fine as the sampling tolerance); the layer is the exact offset of the face
 * @failure a pull parallel to the face (|cos| < 0.01 at a sample) or leaving it on both sides, a footprint that is not a polygon, a draft that closes the profile, a torus face,
 *   scribe, a kernel that cannot build the relief -> `{ code, message }`
 */

import type { ShapeRecipe, Vec2, Vec3 } from '../../model/types';
import type { FaceChart } from '../../geometry/chartFrame';
import { sampleSegment, type PlaneSegment } from '../../geometry/planeSegments';
import { cross3, dot3, normalize3, scale3 } from '../../lib/vec3';
import { eulerFromAxes } from '../../lib/eulerRotation';
import type { UvRegion } from '../../model/wrap';
import { newEntity } from '../entity/newEntity';
import type { FaceSession } from './faceSession';

export interface PullFailure {
  readonly code: string;
  readonly message: string;
}

export interface PullBuild {
  readonly recipe: ShapeRecipe;
  /** Unit direction the feature extends along (out of the material for an emboss, into it for a deboss). */
  readonly axis: Vec3;
  readonly polygonVertices: number;
  readonly draftFaces: number;
}

export const isPullFailure = (value: PullBuild | PullFailure): value is PullFailure => 'code' in value;

const MAX_VERTICES = 4000;
const MIN_COSINE = 0.01;

interface Loop {
  readonly points: Vec3[];
}

/** 3D points of a closed loop of (u, v) pieces: lines of a curved face and curves are sampled. */
function sampleLoop(chart: FaceChart, pieces: readonly PlaneSegment[]): Loop {
  const points: Vec3[] = [];
  for (const piece of pieces) {
    const count = piece.kind === 'line' && chart.kind === 'plane' ? 2 : piece.kind === 'line' ? 17 : 33;
    for (const uv of sampleSegment(piece, count).slice(0, -1)) points.push(chart.pointAt(uv));
  }
  return { points };
}

/** The polygon (x, y) in the basis (e1, e2) with collinear points removed and a counter-clockwise turn. */
function polygonOf(points: readonly Vec3[], e1: Vec3, e2: Vec3, scale: number): Vec2[] {
  const flat: Vec2[] = points.map((p): Vec2 => [dot3(p, e1), dot3(p, e2)]);
  const kept: Vec2[] = [];
  const eps = 1e-9 * scale;
  flat.forEach((point) => {
    const prev = kept[kept.length - 1] ?? (flat[flat.length - 1] as Vec2);
    if (Math.hypot(point[0] - prev[0], point[1] - prev[1]) < eps) return;
    kept.push(point);
  });
  const simplified = kept.filter((point, k) => {
    const prev = kept[(k + kept.length - 1) % kept.length] as Vec2;
    const next = kept[(k + 1) % kept.length] as Vec2;
    const cross = (point[0] - prev[0]) * (next[1] - point[1]) - (point[1] - prev[1]) * (next[0] - point[0]);
    return Math.abs(cross) > eps * Math.hypot(next[0] - prev[0], next[1] - prev[1]);
  });
  const area = simplified.reduce(
    (sum, p, k) =>
      sum + p[0] * (simplified[(k + 1) % simplified.length] as Vec2)[1] - (simplified[(k + 1) % simplified.length] as Vec2)[0] * p[1],
    0,
  );
  return area < 0 ? [...simplified].reverse() : simplified;
}

/** Face-offset layer / pull-prism relief of `regions` on the session's face. */
export function buildPullRecipe(input: {
  readonly session: FaceSession;
  readonly chart: FaceChart;
  readonly orientation: 1 | -1;
  readonly regions: readonly UvRegion[];
  readonly pieces: readonly (readonly PlaneSegment[])[];
  readonly mode: 'emboss' | 'deboss';
  readonly depth: number;
  readonly pull: Vec3;
  readonly draftDeg: number;
  readonly anchorOn: Vec3;
}): PullBuild | PullFailure {
  const { session, chart, orientation, mode, depth } = input;
  if (session.surface.type === 'torus')
    return {
      code: 'WRP_PARAM_INVALID',
      message: 'walls "pull" works on plane, cylinder, cone and sphere faces; a torus has no offset-layer construction here',
    };
  const e0 = normalize3(input.pull);
  const loops = input.pieces.map((pieces) => sampleLoop(chart, pieces));
  const cosines = loops.flatMap((loop) => loop.points.map((p) => dot3(scale3(chart.normalAt(chart.uvOfPoint(p)), orientation), e0)));
  const cosMin = Math.min(...cosines.map(Math.abs));
  const folds = cosines.some((c) => c >= MIN_COSINE) && cosines.some((c) => c <= -MIN_COSINE);
  if (folds)
    return {
      code: 'WRP_PULL_PARALLEL',
      message:
        'the pull direction crosses the face one way on part of the region and the other way on another (the face folds over the region seen along the pull): choose a pull that crosses the whole region the same way',
    };
  if (!(cosMin >= MIN_COSINE))
    return {
      code: 'WRP_PULL_PARALLEL',
      message: `the pull direction is ${((Math.asin(cosMin) * 180) / Math.PI).toFixed(2)} degrees from the face at its steepest sample (limit ${((Math.asin(MIN_COSINE) * 180) / Math.PI).toFixed(2)}): walls along it would not leave the face`,
    };
  const outward = cosines[0] !== undefined && cosines[0] > 0 ? e0 : scale3(e0, -1);
  const axis = mode === 'emboss' ? outward : scale3(outward, -1);
  const helper: Vec3 = Math.abs(e0[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const e1 = normalize3(cross3(e0, helper));
  const e2 = cross3(e0, e1);
  // the heights of the surface over the whole parameter box of the region (a dome rises between the points of its outline)
  const uvs = input.pieces.flatMap((pieces) => pieces.flatMap((piece) => sampleSegment(piece, 9)));
  const [uLow, uHigh] = [Math.min(...uvs.map((p) => p[0])), Math.max(...uvs.map((p) => p[0]))];
  const [vLow, vHigh] = [Math.min(...uvs.map((p) => p[1])), Math.max(...uvs.map((p) => p[1]))];
  const box = Array.from(
    { length: 121 },
    (_, k): Vec3 => chart.pointAt([uLow + ((uHigh - uLow) * (k % 11)) / 10, vLow + ((vHigh - vLow) * Math.floor(k / 11)) / 10]),
  );
  const surfaceHeights = [...loops.flatMap((loop) => loop.points), ...box].map((p) => dot3(p, e0));
  const margin = 1e-6 * session.diagonal;
  const extent = depth / cosMin;
  const [surfaceLow, surfaceHigh] = [Math.min(...surfaceHeights), Math.max(...surfaceHeights)];
  // a draft widens the footprint away from the hinge on the side opposite to the feature axis, where the face is met lower or higher: the window grows with it
  const hingeHeight = dot3(input.anchorOn, e0);
  const growth =
    Math.tan((input.draftDeg * Math.PI) / 180) * Math.max(Math.abs(hingeHeight - surfaceLow), Math.abs(surfaceHigh - hingeHeight) + extent);
  const pad = (2 * growth) / cosMin + margin;
  const [low, high] = dot3(axis, e0) > 0 ? [surfaceLow - pad, surfaceHigh + extent + pad] : [surfaceLow - extent - pad, surfaceHigh + pad];
  const prismOf = (polygon: readonly Vec2[], tag: string): ShapeRecipe => ({
    op: 'place',
    source: { op: 'solid', entity: newEntity('extrusion', `pull-${tag}`, { profile: polygon, depth: high - low }, [0, 0, 0], '#cccccc') },
    position: scale3(e0, low),
    rotation: eulerFromAxes(e1, e2, e0),
  });
  const angle = (input.draftDeg * Math.PI) / 180;
  const hinge = hingeHeight;
  let draftedWalls = 0;
  /** The prism of a footprint polygon; with a draft its walls tilt about the plane through the anchor so it narrows along the feature axis (a hole prism widens). */
  const taperedPrism = (polygon: readonly Vec2[], tag: string, widening: boolean): ShapeRecipe | PullFailure => {
    const prism = prismOf(polygon, tag);
    if (!(angle > 0)) return prism;
    const shape = session.kernel.evaluate(prism);
    if (shape === null)
      return { code: 'WRP_KERNEL_BUILD_FAILED', message: 'the exact kernel could not build the footprint prism before drafting its walls' };
    const walls = (session.query.faceDetails(shape, { samples: 0 }) ?? [])
      .filter((face) => face.surface === 'plane' && face.normal !== undefined && Math.abs(dot3(face.normal, e0)) < 1e-6)
      .map((face) => face.index);
    if (walls.length === 0) return { code: 'WRP_KERNEL_BUILD_FAILED', message: 'the footprint prism has no planar walls to draft' };
    draftedWalls += walls.length;
    return {
      op: 'faceOp',
      source: prism,
      kind: 'draft',
      faces: walls,
      angle,
      pull: widening ? scale3(axis, -1) : axis,
      neutral: { origin: input.anchorOn, normal: axis },
    };
  };
  let vertices = 0;
  const tools: ShapeRecipe[] = [];
  let loopIndex = 0;
  const away = session.surface.type === 'plane' ? 1 : orientation;
  const signedDistance = (mode === 'emboss' ? 1 : -1) * away * depth;
  const offset: ShapeRecipe = {
    op: 'faceOp',
    source: session.source,
    kind: 'moveFaces',
    faces: [session.face],
    move: { type: 'offset', distance: signedDistance },
  };
  const layer: ShapeRecipe =
    mode === 'emboss'
      ? { op: 'boolean', boolean: 'subtract', a: offset, b: session.source }
      : { op: 'boolean', boolean: 'subtract', a: session.source, b: offset };
  const outers: Vec2[][] = [];
  for (const [regionIndex, region] of input.regions.entries()) {
    const outer = polygonOf((loops[loopIndex++] as Loop).points, e1, e2, session.diagonal);
    const holes = region.holes.map(() => polygonOf((loops[loopIndex++] as Loop).points, e1, e2, session.diagonal));
    outers.push(outer);
    vertices += outer.length + holes.reduce((sum, hole) => sum + hole.length, 0);
    if (outer.length < 3 || holes.some((hole) => hole.length < 3))
      return { code: 'WRP_PULL_PARALLEL', message: `region ${regionIndex} projects to a degenerate polygon along the pull` };
  }
  if (vertices > MAX_VERTICES)
    return {
      code: 'WRP_PARAM_INVALID',
      message: `the footprint polygons have ${vertices} vertices (limit ${MAX_VERTICES}): use a simpler or smaller sketch`,
    };
  if (angle > 0) {
    // the prism narrows over its whole length, which reaches farther from the hinge than the relief does
    const reach = Math.max(Math.abs(high - hinge), Math.abs(low - hinge));
    const narrow = Math.min(...outers.map(narrowestSide));
    if (!(2 * reach * Math.tan(angle) < narrow * (1 - 1e-6)))
      return {
        code: 'WRP_DRAFT_CLOSES',
        message: `a draft of ${input.draftDeg} degrees over a height of ${reach.toPrecision(6)} closes a region whose narrowest side is ${narrow.toPrecision(6)} (largest draft ${((Math.atan(narrow / (2 * reach)) * 180) / Math.PI).toPrecision(6)} degrees)`,
      };
  }
  loopIndex = 0;
  for (const [regionIndex, region] of input.regions.entries()) {
    const outerPrism = taperedPrism(outers[regionIndex] as Vec2[], `${regionIndex}`, false);
    if ('code' in outerPrism) return outerPrism;
    loopIndex++;
    let prism: ShapeRecipe = outerPrism;
    for (const [holeIndex] of region.holes.entries()) {
      const hole = polygonOf((loops[loopIndex++] as Loop).points, e1, e2, session.diagonal);
      const holePrism = taperedPrism(hole, `${regionIndex}.${holeIndex}`, true);
      if ('code' in holePrism) return holePrism;
      prism = { op: 'boolean', boolean: 'subtract', a: prism, b: holePrism };
    }
    tools.push({ op: 'boolean', boolean: 'intersect', a: prism, b: layer });
  }
  const combined = tools
    .slice(1)
    .reduce<ShapeRecipe>((sum, tool) => ({ op: 'boolean', boolean: 'union', a: sum, b: tool }), tools[0] as ShapeRecipe);
  const recipe: ShapeRecipe =
    mode === 'emboss'
      ? { op: 'boolean', boolean: 'union', a: session.source, b: combined }
      : { op: 'boolean', boolean: 'subtract', a: session.source, b: combined };
  return { recipe, axis, polygonVertices: vertices, draftFaces: draftedWalls };
}

/** The smaller side of the bounding box of a polygon. */
const narrowestSide = (polygon: readonly Vec2[]): number => {
  const xs = polygon.map((p) => p[0]);
  const ys = polygon.map((p) => p[1]);
  return Math.min(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
};
