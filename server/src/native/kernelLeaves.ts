/**
 * Freeform leaves of the native kernel (RS-1): the pure geometry the WASM OCC kernel computes in TypeScript before it calls OCCT
 * (occtCurves.ts, occtShapes.ts, occtPatches.ts) is computed here with the same core helpers, so the sidecar runs the same OCCT
 * builders on the same numbers (solver/crates/llull-kernel-occt/src/recipe/nodes.rs). Exact profile `curves` become an oriented
 * 3D `chain`; loft, sweep and subdivision entities carry a `native` payload (ring curves, spine and section, Bézier patches plus
 * the fallback triangles).
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
import { sectionChain } from '@core/geometry/sectionChain';
import { frameAtFraction, stationRingAt, sweepStartAxes } from '@core/geometry/sweep';
import { subdivisionPatches } from '@core/geometry/subdivisionPatches';
import { clamp } from '@lib/clamp';
import { signedArea } from '@lib/polygon';
import { add3, scale3 } from '@lib/vec3';

const SEGMENT_CODES = { line: 0, arc: 1, bezier: 2 } as const;

/** Wire form of a chain: per segment its type code (0 line, 1 arc, 2 cubic Bézier), then its points' xyz. */
export function encodeChain(chain: ReadonlyArray<CurveSegment<Vec3>>): number[] {
  return chain.flatMap((segment) => [SEGMENT_CODES[segment.type], ...segment.points.flat()]);
}

/** occtCurves.ts `chainFace` up to OCCT: the closed 2D chain oriented (counter-clockwise or not) then lifted by `place`. */
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

/** occtCurves.ts SKIN_SECTIONS_PER_SEGMENT. */
const SKIN_SECTIONS_PER_SEGMENT = 8;

/** occtCurves.ts `stationSweep`: the station rings placed in the sweep frame at the skin fractions. */
function stationRings(entity: SweepEntity): number[][] {
  const stations = entity.stations ?? [];
  const count = clamp(entity.path.length * SKIN_SECTIONS_PER_SEGMENT, 8, 64);
  const fractions = [
    ...new Set([...Array.from({ length: count + 1 }, (_, k) => k / count), ...stations.map((station) => station.at)]),
  ].sort((a, b) => a - b);
  return fractions.map((t) => {
    const frame = frameAtFraction(entity.path, t);
    const ring = stationRingAt(stations, t).map(([x, y]) => add3(frame.point, add3(scale3(frame.normal, x), scale3(frame.binormal, y))));
    return encodeChain(ringCurves(ring));
  });
}

/** occtCurves.ts `sectionFace` inputs: a circle (with its bore) or the oriented profile chain in the start frame. */
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

function sweepPayload(entity: SweepEntity): Record<string, unknown> {
  const spine = encodeChain(entity.path);
  if (entity.stations !== undefined && entity.stations.length >= 2) return { spine, rings: stationRings(entity) };
  return { spine, ...sectionPayload(entity) };
}

const NO_COMPONENTS = createEmptyDocument();

/** occtShapes.ts subdivision branch: exact patches for a smooth cage (sewing tolerance from its span), the triangles always. */
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

/** The leaf the sidecar builds for `entity` (see the module comment). */
export function nativeLeaf(entity: Entity): Entity {
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
    case 'loft':
      return withPayload(entity, { chains: loftChains(entity), ruled: entity.ruled });
    case 'sweep':
      return withPayload(entity, sweepPayload(entity));
    case 'subdivision':
      return withPayload(entity, subdivisionPayload(entity));
    default:
      return entity;
  }
}
