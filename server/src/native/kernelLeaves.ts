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
import { mapSegment, reverseChain, sampleProfile, segmentTangent } from '@core/geometry/curveSegments';
import { ringCurves } from '@core/geometry/sectionRing';
import { hasClosingEdge, sectionChain } from '@core/geometry/sectionChain';
import type { NurbsCurveData } from '@lib/nurbs/types';
import { frameAtFraction, sweepStartAxes } from '@core/geometry/sweepEval/frames';
import { stationRingAt } from '@core/geometry/sweepEval/sections';
import { helixFrame } from '@lib/helix/helix';
import { fitSweepFaces, fitToleranceOf, sewToleranceOf } from '@core/geometry/sweepEval/fitted';
import { needsFittedFaces } from '@core/geometry/sweepEval/realisation';
import { subdivisionPatches } from '@core/geometry/subdivisionPatches';
import { encodeLoops, encodeSurface } from '@core/geometry/surfaceWire';
import { clamp } from '@lib/clamp';
import { signedArea } from '@lib/polygon';
import { add3, scale3 } from '@lib/vec3';

const SEGMENT_CODES = { line: 0, arc: 1, bezier: 2 } as const;

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
function fittedPayload(entity: SweepEntity, wire: WireOptions): Record<string, unknown> | null {
  if (wire.sheetSolid !== true) return null;
  const fit = fitSweepFaces(entity, fitToleranceOf(entity));
  return 'faces' in fit ? { faces: fit.faces, tolerance: sewToleranceOf(entity) } : null;
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

function sweepPayload(entity: SweepEntity, wire: WireOptions): Record<string, unknown> {
  if (needsFittedFaces(entity)) {
    const fitted = fittedPayload(entity, wire);
    // a plain helix the faces cannot express (a bore) keeps the exact helix spine, a station sweep with only a blend keeps its rings; laws and
    // frame modes have no pipe equivalent
    const plain =
      entity.orientation === undefined && [entity.twist, entity.scale, entity.area, entity.stretch].every((law) => law === undefined);
    if (fitted !== null || !plain || (entity.helix === undefined && entity.stations === undefined)) return fitted ?? {};
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
      return withPayload(entity, { chains: loftChains(entity), ruled: entity.ruled, ...(bsplines === null ? {} : { bsplines }) });
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
