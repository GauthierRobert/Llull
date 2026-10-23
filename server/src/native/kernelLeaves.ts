/**
 * Freeform leaves of the native kernel (RS-1): the pure geometry computed in TypeScript (core helpers) before the OCCT call is
 * computed here, so the sidecar's OCCT builders receive ready numbers (solver/crates/llull-kernel-occt/src/recipe/nodes.rs). Exact profile `curves` become an oriented
 * 3D `chain`; loft, sweep and subdivision entities carry a `native` payload (ring curves, spine and section, Bézier patches plus
 * the fallback triangles), a `nurbs_surface` sheet its encoded surface and trim loops.
 * @invariant pure: no process, no I/O; an entity the sidecar builds without help is returned unchanged
 */

import type { CurveSegment } from '@core/model/curve';
import type { Entity, Vec2, Vec3 } from '@core/model/types';
import { createEmptyDocument } from '@core/model/types';
import { entityTrianglePositions } from '@core/geometry/entityTriangles';
import { orientOutward } from '@core/geometry/meshVolume';
import { revolutionAxisIndex } from '@core/geometry/revolution';
import { isClosedChain, mapSegment, reverseChain, sampleProfile, segmentTangent } from '@core/geometry/curveSegments';
import { ringCurves } from '@core/geometry/sectionRing';
import { hasClosingEdge, sectionChain } from '@core/geometry/sectionChain';
import type { NurbsCurveData } from '@lib/nurbs/types';
import { frameAtFraction, sweepStartAxes } from '@core/geometry/sweepEval/frames';
import { pathLength } from '@core/geometry/sweepEval/evaluate';
import { sweepSegmentRings } from '@core/geometry/sweep';
import { sectionTransforms } from '@core/geometry/sweepEval/laws';
import { stationRingAt } from '@core/geometry/sweepEval/sections';
import { helixFrame } from '@lib/helix/helix';
import { fitSweepFaces, fitToleranceOf, sewToleranceOf } from '@core/geometry/sweepEval/fitted';
import { needsFittedFaces } from '@core/geometry/sweepEval/realisation';
import { subdivisionPatches } from '@core/geometry/subdivisionPatches';
import { encodeLoops, encodeSurface } from '@core/geometry/surfaceWire';
import { clamp } from '@lib/clamp';
import { extractSubSurface } from '@lib/nurbs/surfaceEdit';
import type { NurbsSurfaceData } from '@lib/nurbs/surfaceTypes';
import { signedArea } from '@lib/polygon';
import { add3, scale3 } from '@lib/vec3';

const SEGMENT_CODES = { line: 0, arc: 1, bezier: 2, ellipse: 3 } as const;

/** Wire form of a chain: per segment its type code (0 line, 1 arc, 2 cubic Bézier), then its points' xyz. */
export function encodeChain(chain: ReadonlyArray<CurveSegment<Vec3>>): number[] {
  return chain.flatMap((segment) => [SEGMENT_CODES[segment.type], ...segment.points.flat()]);
}

/** Face-chain geometry up to OCCT: the closed 2D chain oriented (counter-clockwise or not) then lifted by `place`. */
export function orientedChain(
  curves: ReadonlyArray<CurveSegment<Vec2>>,
  place: (point: Vec2) => Vec3,
  counterClockwise: boolean,
): number[] {
  const isCounterClockwise = signedArea(sampleProfile(curves)) > 0;
  const oriented = isCounterClockwise === counterClockwise ? curves : reverseChain(curves);
  return encodeChain(oriented.map((segment) => mapSegment(segment, (point) => place(point))));
}

type SweepEntity = Extract<Entity, { kind: 'sweep' }>;

/** Skin sections per spine segment. */
const SKIN_SECTIONS_PER_SEGMENT = 8;

/** Sweep stations: the station rings placed in the sweep frame at the skin fractions. */
function stationRings(entity: SweepEntity): number[][] {
  const stations = entity.stations ?? [];
  const count = clamp(entity.path.length * SKIN_SECTIONS_PER_SEGMENT, 8, 64);
  const fractions = [
    ...new Set([...Array.from({ length: count + 1 }, (_, k) => k / count), ...stations.map((station) => station.at)]),
  ].sort((a, b) => a - b);
  return fractions.map((t) => {
    const frame = frameAtFraction(entity.path, t);
    const ring = stationRingAt(stations, t, entity.stationBlend).map(([x, y]) =>
      add3(frame.point, add3(scale3(frame.normal, x), scale3(frame.binormal, y))),
    );
    return encodeChain(ringCurves(ring));
  });
}

/** Section-face inputs: a circle (with its bore) or the oriented profile chain in the start frame. */
function sectionPayload(entity: SweepEntity): Record<string, unknown> {
  const first = entity.path[0];
  if (first === undefined) return {};
  const start = first.points[0];
  const tangent = segmentTangent(first, 0);
  const { section } = entity;
  if (section.shape === 'circle') {
    const circle = { center: start, normal: tangent, radius: section.radius };
    return { circle: section.innerRadius === undefined ? circle : { ...circle, innerRadius: section.innerRadius } };
  }
  const { normal, binormal } = sweepStartAxes(tangent);
  const place = ([x, y]: Vec2): Vec3 => add3(start, add3(scale3(normal, x), scale3(binormal, y)));
  const curves: ReadonlyArray<CurveSegment<Vec2>> =
    section.curves ??
    section.profile.map((p, i) => ({
      type: 'line' as const,
      points: [p, section.profile[(i + 1) % section.profile.length] as Vec2] as const,
    }));
  return { chain: orientedChain(curves, place, true) };
}

/** Fitted lateral faces for laws, frame modes and helices (MakePipe is an approximation there); null when they cannot be built. */
function fittedPayload(
  entity: SweepEntity,
  wire: WireOptions,
): { faces: number[][]; tolerance: number; caps: 0 | 2; probes: number[] } | null {
  if (wire.sheetSolid !== true) return null;
  const fit = fitSweepFaces(entity, fitToleranceOf(entity));
  return 'faces' in fit
    ? { faces: fit.faces, tolerance: sewToleranceOf(entity), caps: isClosedChain(entity.path) ? 0 : 2, probes: fit.probes }
    : null;
}

/** Trihedron modes MakePipeShell offers for the orientation modes the sweep evaluator shares with it. */
const SHELL_MODES: Readonly<Record<string, number>> = { minimal: 0, frenet: 1, fixed: 2, binormal: 3 };

/** Samples of the section scale (laws folded in) at 33 path fractions, as (fraction, scale) pairs for a homothetic law. */
function scalePairs(entity: SweepEntity): number[] | null {
  const ts = Array.from({ length: 33 }, (_, k) => k / 32);
  const transforms = sectionTransforms(entity, ts, pathLength(entity));
  return transforms.flatMap((transform, k) => [ts[k] as number, transform.sx]);
}

/**
 * The MakePipeShell attempt of a sweep (capability `pipeShell`, TECHNICAL_SPEC 5.5): a constant section with a scale / area law and/or a frame mode
 * OCC has an equivalent for. The sidecar uses its result only when it passes `probes` (points of the fitted faces), so a wrong equivalent (e.g. the
 * corrected Frenet frame on a twisting path) falls back to the faces.
 */
function pipeShellPayload(entity: SweepEntity, faces: { tolerance: number; probes: number[] }): Record<string, unknown> | null {
  const unsupported =
    isClosedChain(entity.path) ||
    [entity.stations, entity.rails, entity.helix, entity.twist, entity.stretch].some((field) => field !== undefined);
  const mode = entity.orientation?.mode ?? 'minimal';
  const lawed = entity.scale !== undefined || entity.area !== undefined;
  if (unsupported || SHELL_MODES[mode] === undefined || !(lawed || mode !== 'minimal')) return null;
  const orientation = entity.orientation;
  const direction = orientation?.mode === 'fixed' || orientation?.mode === 'binormal' ? (orientation.direction ?? [0, 0, 1]) : [0, 0, 1];
  return {
    mode: SHELL_MODES[mode],
    direction,
    ...(lawed ? { law: scalePairs(entity) } : {}),
    transition: 0,
    tolerance: faces.tolerance,
    probes: faces.probes,
    check: faces.tolerance,
  };
}

/** The exact helix as the sidecar reads it (capability `helixEdge`): constant-pitch helices only; a pitch law keeps the Bézier spine. */
function helixPayload(entity: SweepEntity, wire: WireOptions): number[] | null {
  const helix = entity.helix;
  if (wire.helixEdge !== true || helix === undefined || helix.type !== 'helix' || typeof helix.pitch !== 'number') return null;
  const { x } = helixFrame(helix.axis);
  return [
    ...helix.origin,
    ...helix.axis,
    ...x,
    helix.radius,
    helix.endRadius,
    helix.turns,
    helix.pitch,
    helix.handedness === 'left' ? 1 : 0,
    helix.startAngle,
  ];
}

/**
 * A mitred sweep (corners: miter): the spine with its sharp joints and the section, plus a MakePipeShell attempt with the right-corner transition
 * (capability `pipeShell`) that must pass probe points of the evaluator's rings (the mitre rings lie on the exact boundary); MakePipe is the fallback.
 */
function miterPayload(entity: SweepEntity, wire: WireOptions): Record<string, unknown> {
  const base = { spine: encodeChain(entity.path), ...sectionPayload(entity) };
  if (wire.pipeShell !== true) return base;
  const probes = sweepSegmentRings(entity).flatMap((ring) =>
    [0, 0.25, 0.5, 0.75].flatMap((f) => [...(ring[Math.floor(f * ring.length)] as Vec3)]),
  );
  const tolerance = sewToleranceOf(entity);
  return { ...base, pipeShell: { mode: 0, direction: [0, 0, 1], transition: 1, tolerance, probes, check: tolerance } };
}

function sweepPayload(entity: SweepEntity, wire: WireOptions): Record<string, unknown> {
  if (entity.corners === 'miter') return miterPayload(entity, wire);
  if (needsFittedFaces(entity)) {
    const fitted = fittedPayload(entity, wire);
    const shell = fitted !== null && wire.pipeShell === true ? pipeShellPayload(entity, fitted) : null;
    // a plain helix the faces cannot express (a bore) keeps the exact helix spine, a station sweep with only a blend keeps its rings; laws and
    // frame modes have no pipe equivalent
    const plain =
      entity.orientation === undefined && [entity.twist, entity.scale, entity.area, entity.stretch].every((law) => law === undefined);
    if (fitted !== null || !plain || (entity.helix === undefined && entity.stations === undefined)) {
      if (fitted === null) return {};
      const faces = { faces: fitted.faces, tolerance: fitted.tolerance, caps: fitted.caps };
      return shell === null ? faces : { ...faces, spine: encodeChain(entity.path), ...sectionPayload(entity), pipeShell: shell };
    }
  }
  const spine = encodeChain(entity.path);
  const helix = helixPayload(entity, wire);
  if (entity.stations !== undefined && entity.stations.length >= 2) return { spine, rings: stationRings(entity) };
  return { spine, ...(helix === null ? {} : { helix }), ...sectionPayload(entity) };
}

const NO_COMPONENTS = createEmptyDocument();

/** Subdivision branch: exact patches for a smooth cage (sewing tolerance from its span), the triangles always. */
function subdivisionPayload(entity: Extract<Entity, { kind: 'subdivision' }>): Record<string, unknown> {
  const positions = entityTrianglePositions(entity, NO_COMPONENTS);
  const triangles = { positions, indices: orientOutward(positions, []) };
  if (!(entity.levels > 0)) return { triangles };
  const span = Math.max(...entity.vertices.flatMap((p) => p.map(Math.abs)), 1);
  const patches = subdivisionPatches(entity).flatMap((patch) => patch.flat());
  return { patches, tolerance: span * 1e-7, triangles };
}

/** A leaf carrying only placement and the native payload (the source fields would be dead weight on the wire). */
function withPayload(entity: Entity, native: Record<string, unknown>): Entity {
  const { id, kind, layerId, color, position, rotation } = entity;
  return { id, kind, layerId, color, position, rotation, native } as unknown as Entity;
}

/** Wire chains of a loft: its exact sections (Béziers + closing edge) when every one is expressible, else the Catmull-Rom ring curves. */
function loftChains(entity: Extract<Entity, { kind: 'loft' }>): number[][] {
  const chains = entity.sections?.map(sectionChain);
  if (chains?.every((chain): chain is CurveSegment<Vec3>[] => chain !== null) === true) return chains.map(encodeChain);
  return entity.rings.map((ring) => encodeChain(ringCurves(ring)));
}

/** What the host sends beyond the baseline wire format, decided by the capabilities the sidecar reported in `info`. */
export interface WireOptions {
  /** Capability `bsplineSections`: a loft also carries each exact section as ONE B-spline curve (`native.bsplines`). */
  readonly bsplineSections?: boolean;
  /** Capability `nurbsSurface`: a `nurbs_surface` sheet leaf carries its surface and trim loops (`native.surface`, `native.loops`). */
  readonly nurbsSurface?: boolean;
  /** Capability `sheetSolid`: a sweep with laws or a non-default frame carries fitted lateral faces (`native.faces`) the sidecar sews and caps. */
  readonly sheetSolid?: boolean;
  /** Capability `helixEdge`: a sweep along an `add_helix` curve carries the exact helix (`native.helix`) the sidecar builds the spine from. */
  readonly helixEdge?: boolean;
  /** Capability `pipeShell`: a sweep with a homothetic law or a frame mode also carries a MakePipeShell attempt (`native.pipeShell`), used only when it passes its probes. */
  readonly pipeShell?: boolean;
}

/**
 * Wire form of one B-spline section: degree, pole count, distinct knot count, rational flag, closing-edge flag, then the xyz poles, the weights
 * (rational only), the distinct knots and their multiplicities. The closing flag asks for a straight edge from the last pole back to the first.
 */
export function encodeBspline(curve: NurbsCurveData, closing: boolean): number[] {
  const rational = curve.weights !== undefined;
  return [
    curve.degree,
    curve.poles.length,
    curve.knots.length,
    rational ? 1 : 0,
    closing ? 1 : 0,
    ...curve.poles.flat(),
    ...(curve.weights ?? []),
    ...curve.knots,
    ...curve.multiplicities,
  ];
}

/** A face cut at its u knots into single-span faces, like the faces of a fitted sweep: the sewing then joins edges of different faces (a whole section as one face closes on itself and is not sewn). */
function spans(face: NurbsSurfaceData): NurbsSurfaceData[] {
  const v: readonly [number, number] = [face.knotsV[0] as number, face.knotsV[face.knotsV.length - 1] as number];
  if (face.knotsU.length < 3) return [face];
  const pieces = face.knotsU.slice(1).map((end, k) => extractSubSurface(face, [face.knotsU[k] as number, end], v));
  return pieces.every((piece): piece is NurbsSurfaceData => typeof piece !== 'string') ? pieces : [face];
}

/** Exact skin of an advanced loft (capability `sheetSolid`): the NURBS faces the sidecar sews and caps, with the sewing tolerance (1e-6 of the skin's size). */
function loftFaces(entity: Extract<Entity, { kind: 'loft' }>, wire: WireOptions): Record<string, unknown> {
  if (wire.sheetSolid !== true || entity.faces === undefined || entity.faces.length === 0) return {};
  const faces = entity.faces.flatMap(spans);
  const poles = faces.flatMap((face) => face.poles.flat());
  const extent = [0, 1, 2].map(
    (axis) => Math.max(...poles.map((p) => p[axis] as number)) - Math.min(...poles.map((p) => p[axis] as number)),
  );
  return { faces: faces.map(encodeSurface), tolerance: Math.max(1e-7, 1e-6 * Math.hypot(...extent)), caps: entity.caps ?? 2 };
}

/** The exact sections of a loft as B-spline wire data, or null when the loft has none (a loft of sketches keeps the chains only). */
function loftBsplines(entity: Extract<Entity, { kind: 'loft' }>): number[][] | null {
  return entity.sections === undefined ? null : entity.sections.map((curve) => encodeBspline(curve, hasClosingEdge(curve)));
}

/** The leaf the sidecar builds for `entity` (see the module comment). */
export function nativeLeaf(entity: Entity, wire: WireOptions = {}): Entity {
  switch (entity.kind) {
    case 'extrusion': {
      if (entity.curves === undefined) return entity;
      const { curves, ...rest } = entity;
      return { ...rest, chain: orientedChain(curves, ([x, y]) => [x, y, 0], true) } as unknown as Entity;
    }
    case 'revolution': {
      if (entity.curves === undefined) return entity;
      const frame = revolutionAxisIndex(entity.axis);
      const place = ([radial, axial]: Vec2): Vec3 =>
        frame === 2 ? [radial, 0, axial] : frame === 1 ? [radial, axial, 0] : [axial, radial, 0];
      const { curves, ...rest } = entity;
      return { ...rest, chain: orientedChain(curves, place, frame === 1) } as unknown as Entity;
    }
    case 'loft': {
      const bsplines = wire.bsplineSections === true ? loftBsplines(entity) : null;
      return withPayload(entity, {
        chains: loftChains(entity),
        ruled: entity.ruled,
        ...(bsplines === null ? {} : { bsplines }),
        ...loftFaces(entity, wire),
      });
    }
    case 'sweep':
      return withPayload(entity, sweepPayload(entity, wire));
    case 'subdivision':
      return withPayload(entity, subdivisionPayload(entity));
    case 'nurbs_surface':
      if (wire.nurbsSurface !== true) return entity;
      return withPayload(entity, { surface: encodeSurface(entity.surface), loops: encodeLoops(entity.trims ?? []) });
    default:
      return entity;
  }
}
