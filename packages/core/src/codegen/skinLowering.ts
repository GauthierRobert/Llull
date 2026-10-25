/**
 * Lower a sweep or a loft (02 SWG) to the construction generated code rebuilds: the library's own where it maps faithfully (a pipe shell of the
 * exact path wire, the exact helix, a thru-sections loft, a right-corner mitre), the evaluator's fitted B-spline faces otherwise (laws, rails,
 * stations, frame modes, non-round sections on non-planar paths, closed paths, advanced lofts).
 * @invariant poles are entity-local (the solid feature carries the placement); `fallback` is the entity's world-space display soup
 * @failure a sweep the fit refuses (degenerate section arc, tolerance), a hollow tube with stations, a mitre with laws, more than MAX_SKIN_POLES
 *   poles, a failed face split, a closed loft without faces -> a mesh carrying a named SWG_CODEGEN_UNSUPPORTED reason (never a different solid)
 */

import type { CadDocument, LoftEntity, SweepEntity, Vec2, Vec3 } from '../model/types';
import type { CurveSegment } from '../model/curve';
import type { NurbsSurfaceData } from '../lib/nurbs/surfaceTypes';
import { extractSubSurface } from '../lib/nurbs/surfaceEdit';
import { add3, dot3, normalize3, scale3 } from '../lib/vec3';
import { helixAt, helixFrame } from '../lib/helix/helix';
import { entityTrianglePositions } from '../geometry/entityTriangles';
import { chainLength, closesSmoothly, isClosedChain, minCurvatureRadius, segmentTangent } from '../geometry/curveSegments';
import { sharpJoints } from '../geometry/sweepEval/miter';
import { hasClosingEdge } from '../geometry/sectionChain';
import { ringCurves } from '../geometry/sectionRing';
import { fitSweepFaces, fitToleranceOf, sewToleranceOf } from '../geometry/sweepEval/fitted';
import { sweepStartAxes } from '../geometry/sweepEval/frames';
import { hasSweepLaws } from '../geometry/sweepEval/laws';
import { needsFittedFaces } from '../geometry/sweepEval/realisation';
import type { Feature, FeatureProgram, LoftSection, PipeSection, ShapeSpec, SweptBuild, TracedCall } from './program';

/** Most poles one generated skin may carry (about 300 000 numbers, a few MB of data section): beyond it the source is unreadable and the mesh is kept. */
const MAX_SKIN_POLES = 100_000;

type Refusal = { readonly reason: string };
const refusal = (reason: string): Refusal => ({ reason });
const isRefusal = (value: unknown): value is Refusal => typeof value === 'object' && value !== null && 'reason' in value;

const poleCount = (faces: readonly NurbsSurfaceData[]): number =>
  faces.reduce((sum, face) => sum + face.poles.length * (face.poles[0]?.length ?? 0), 0);

/** A face cut at its u knots into single-span faces, so sewing joins edges of different faces (a whole closed section as one face closes on itself and is not sewn). */
function spans(face: NurbsSurfaceData): NurbsSurfaceData[] | Refusal {
  const v: readonly [number, number] = [face.knotsV[0] as number, face.knotsV[face.knotsV.length - 1] as number];
  if (face.knotsU.length < 3) return [face];
  const pieces = face.knotsU.slice(1).map((end, k) => extractSubSurface(face, [face.knotsU[k] as number, end], v));
  return pieces.every((piece): piece is NurbsSurfaceData => typeof piece !== 'string')
    ? pieces
    : refusal('has a face that cannot be split at its knots');
}

function tooLarge(count: number): Refusal | null {
  return count > MAX_SKIN_POLES ? refusal(`needs ${count} fitted poles (more than ${MAX_SKIN_POLES})`) : null;
}

/** Fitted faces of one sweep, or the reason it has none. */
function fitFaces(entity: SweepEntity): NurbsSurfaceData[] | Refusal {
  const fit = fitSweepFaces(entity, fitToleranceOf(entity));
  return 'code' in fit ? refusal(`has no exact faces (${fit.code}: ${fit.message})`) : fit.surfaces;
}

const roundSection = (entity: SweepEntity): { radius: number; innerRadius?: number } | null =>
  entity.section.shape === 'circle'
    ? { radius: entity.section.radius, ...(entity.section.innerRadius === undefined ? {} : { innerRadius: entity.section.innerRadius }) }
    : null;

const facesCache = new WeakMap<object, SweptBuild | Refusal>();

/** The fitted-faces construction (outer faces, plus the bore's faces for a hollow tube); the fit is the expensive part, so it is computed once per entity. */
function facesBuild(entity: SweepEntity): SweptBuild | Refusal {
  const cached = facesCache.get(entity);
  if (cached !== undefined) return cached;
  const made = fitBuild(entity);
  facesCache.set(entity, made);
  return made;
}

function fitBuild(entity: SweepEntity): SweptBuild | Refusal {
  const { section } = entity;
  if (section.shape === 'circle' && section.innerRadius !== undefined && entity.stations !== undefined)
    return refusal('has a bore and stations, which no generated code rebuilds');
  const outer = fitFaces(section.shape === 'circle' ? { ...entity, section: { shape: 'circle', radius: section.radius } } : entity);
  if (isRefusal(outer)) return outer;
  const bore =
    section.shape === 'circle' && section.innerRadius !== undefined
      ? fitFaces({ ...entity, section: { shape: 'circle', radius: section.innerRadius } })
      : null;
  if (isRefusal(bore)) return bore;
  const large = tooLarge(poleCount(outer) + (bore === null ? 0 : poleCount(bore)));
  if (large !== null) return large;
  return {
    kind: 'faces',
    faces: outer,
    ...(bore === null ? {} : { bore }),
    cap: !isClosedChain(entity.path),
    tolerance: sewToleranceOf(entity),
  };
}

/** The section placed at the spine start: the circle or the polygon in the start frame. */
function sectionAt(entity: SweepEntity, start: Vec3, tangent: Vec3): PipeSection | null {
  const { section } = entity;
  if (section.shape === 'circle') return { kind: 'circle', center: start, normal: tangent, radius: section.radius };
  if ((section.curves ?? []).some((segment) => segment.type !== 'line')) return null;
  const { normal, binormal } = sweepStartAxes(tangent);
  const place = ([x, y]: Vec2): Vec3 => add3(start, add3(scale3(normal, x), scale3(binormal, y)));
  return { kind: 'polygon', points: section.profile.map(place) };
}

/** Laws, rails, stations, frame modes, a helix or a closed non-round or kinked path: anything the plain pipe shell does not express. */
const plainPipe = (entity: SweepEntity): boolean =>
  !hasSweepLaws(entity) &&
  [entity.orientation, entity.helix, entity.rails, entity.stations].every((field) => field === undefined) &&
  (!isClosedChain(entity.path) || (entity.section.shape === 'circle' && closesSmoothly(entity.path)));

/** The reason a mitred sweep is not the plain right-corner pipe, or null. */
function mitreRefusal(entity: SweepEntity): string | null {
  const straight = plainPipe(entity) && entity.path.every((segment) => segment.type === 'line');
  if (!straight) return 'has mitred corners with laws, a frame mode, rails, stations or curved legs (SWG M1 corners: miter)';
  const { section } = entity;
  const curved = section.shape === 'profile' && (section.curves ?? []).some((segment) => segment.type !== 'line');
  return curved || (section.shape === 'circle' && section.innerRadius !== undefined)
    ? 'has mitred corners with a bored or curved-edge section (SWG M1 corners: miter)'
    : null;
}

/** Unit mitre reach of a leg's two ends (tan(turn / 2) of its joints) against its length: the radius at which a mitre leg is too short (sweep_profile refuses from there; matches it to the printed precision, 12 significant digits). */
function mitreLimit(path: ReadonlyArray<CurveSegment<Vec3>>): number | undefined {
  const needs = new Map<number, number>();
  for (const joint of sharpJoints(path)) {
    const [a, b] = [path[joint] as CurveSegment<Vec3>, path[joint + 1] as CurveSegment<Vec3>];
    needs.set(joint, Math.tan(Math.acos(Math.min(1, dot3(segmentTangent(a, 1), segmentTangent(b, 0)))) / 2));
  }
  const limits = path.flatMap((leg, i) => {
    const reach = (needs.get(i - 1) ?? 0) + (needs.get(i) ?? 0);
    return reach > 0 ? [chainLength([leg]) / reach] : [];
  });
  return limits.length === 0 ? undefined : Math.min(...limits);
}

/** The radius from which sweep_profile refuses this path: a bend not wider than the section, or (mitre) a leg shorter than the mitre reaches. */
function radiusLimit(entity: SweepEntity, mitre: boolean): number | undefined {
  if (mitre) return mitreLimit(entity.path);
  const bend = Math.min(...entity.path.map(minCurvatureRadius));
  return Number.isFinite(bend) ? bend : undefined;
}

/** The plain / mitred pipe shell along the entity's exact path. */
function pipeBuild(entity: SweepEntity, mitre: boolean): SweptBuild | null {
  const first = entity.path[0] as CurveSegment<Vec3>;
  const section = sectionAt(entity, first.points[0], segmentTangent(first, 0));
  if (section === null) return null;
  const round = roundSection(entity);
  const limit = radiusLimit(entity, mitre);
  return {
    kind: 'pipe',
    spine: entity.path.map((segment) => [...segment.points]),
    section,
    mitre,
    ...(round?.innerRadius === undefined ? {} : { bore: round.innerRadius }),
    ...(limit === undefined ? {} : { limit }),
  };
}

/** A round section along an exact constant-pitch cylindrical helix. */
function helixBuild(entity: SweepEntity): SweptBuild | null {
  const { helix } = entity;
  const round = roundSection(entity);
  const free = !hasSweepLaws(entity) && [entity.orientation, entity.rails, entity.stations].every((field) => field === undefined);
  if (helix === undefined || round === null || !free || helix.type !== 'helix' || typeof helix.pitch !== 'number') return null;
  if (helix.endRadius !== helix.radius || isClosedChain(entity.path)) return null;
  const start = helixAt(helix, 0);
  return {
    kind: 'helix',
    origin: helix.origin,
    axis: helix.axis,
    xAxis: helixFrame(helix.axis).x,
    radius: helix.radius,
    pitch: helix.pitch,
    turns: helix.turns,
    left: helix.handedness === 'left',
    startAngle: helix.startAngle,
    section: { kind: 'circle', center: start.point, normal: normalize3(start.derivative), radius: round.radius },
    ...(round.innerRadius === undefined ? {} : { bore: round.innerRadius }),
  };
}

function sweepBuild(entity: SweepEntity): SweptBuild | Refusal {
  if (entity.corners === 'miter') {
    const why = mitreRefusal(entity);
    const pipe = why === null ? pipeBuild(entity, true) : null;
    return pipe ?? refusal(why ?? 'has mitred corners with a curved-edge section (SWG M1 corners: miter)');
  }
  if (plainPipe(entity) && !needsFittedFaces(entity)) {
    const pipe = pipeBuild(entity, false);
    if (pipe !== null) return pipe;
  }
  return helixBuild(entity) ?? facesBuild(entity);
}

/** Sections of a basic loft: its exact curves (a B-spline each, closed by a straight edge when its ends differ) or the Catmull-Rom curves of its rings. */
function loftSections(entity: LoftEntity): LoftSection[] {
  if (entity.sections !== undefined) return entity.sections.map((curve) => ({ kind: 'bspline', curve, closing: hasClosingEdge(curve) }));
  return entity.rings.map((ring) => ({ kind: 'chain', segments: ringCurves(ring).map((segment) => [...segment.points]) }));
}

function sizeOf(faces: readonly NurbsSurfaceData[]): number {
  const poles = faces.flatMap((face) => face.poles.flat());
  const extent = [0, 1, 2].map(
    (axis) => Math.max(...poles.map((p) => p[axis] as number)) - Math.min(...poles.map((p) => p[axis] as number)),
  );
  return Math.hypot(...extent);
}

function loftBuild(entity: LoftEntity): SweptBuild | Refusal {
  if (entity.faces !== undefined && entity.faces.length > 0) {
    const pieces = entity.faces.map(spans);
    const refused = pieces.find(isRefusal);
    if (refused !== undefined) return refused;
    const faces = (pieces as NurbsSurfaceData[][]).flat();
    const large = tooLarge(poleCount(faces));
    if (large !== null) return large;
    return { kind: 'faces', faces, cap: (entity.caps ?? 2) > 0, tolerance: Math.max(1e-7, 1e-6 * sizeOf(faces)) };
  }
  if (entity.closed === true) return refusal('is closed but carries no exact faces');
  return { kind: 'loft', sections: loftSections(entity), ruled: entity.ruled };
}

const fallbackCache = new WeakMap<object, readonly number[]>();

/**
 * The shape spec of a sweep or loft. The fit and the display soup are computed once per entity object; `trace` (the step's params, when it can be
 * replayed) is attached.
 */
export function skinShape(entity: SweepEntity | LoftEntity, doc: CadDocument, trace: TracedCall | null): ShapeSpec {
  const subject = `${entity.kind} '${entity.id}'`;
  let fallback = fallbackCache.get(entity);
  if (fallback === undefined) {
    fallback = entityTrianglePositions(entity, doc);
    fallbackCache.set(entity, fallback);
  }
  const build = entity.kind === 'sweep' ? sweepBuild(entity) : loftBuild(entity);
  if (isRefusal(build))
    return {
      kind: 'mesh',
      positions: fallback,
      reason: `SWG_CODEGEN_UNSUPPORTED: ${subject} ${build.reason}; exported as the exact result's triangle mesh.`,
    };
  return { kind: 'swept', subject, build, ...(trace === null ? {} : { trace }), fallback };
}

/** Name every sweep / loft that stayed a mesh: a comment before its solid and a program note (the reason is on the mesh spec). */
export function withRefusalNotes(program: FeatureProgram): FeatureProgram {
  const notes = new Set<string>();
  const features = program.features.flatMap((feature): Feature[] => {
    if (feature.op !== 'solid' || feature.shape.kind !== 'mesh' || feature.shape.reason === undefined) return [feature];
    notes.add(feature.shape.reason);
    return [{ step: feature.step, command: feature.command, variable: feature.variable, op: 'note', text: feature.shape.reason }, feature];
  });
  return notes.size === 0 ? program : { ...program, features, notes: [...program.notes, ...notes] };
}
