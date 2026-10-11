/**
 * @layer kernel
 * Exact curve geometry for OCC: `CurveSegment` chains → edges (segment, circular arc, cubic
 * Bézier) → wires → planar faces, and sweeps (BRepOffsetAPI_MakePipe along the exact path with a
 * corrected-Frenet, i.e. twist-minimizing, trihedron). Callers own (release) returned shapes.
 */

import type { CurveSegment } from '@core/model/curve';
import type { Entity, Vec2, Vec3 } from '@core/model/types';
import { sweepStartAxes } from '@core/geometry/sweep';
import { reverseChain, sampleProfile, segmentTangent } from '@core/geometry/curveSegments';
import { add3, scale3 } from '@lib/vec3';
import { signedArea } from '@lib/polygon';
import { release, type OccApi, type OccHandle, type OccMakeFace, type OccShape } from './occtTypes';

interface OccEdgeMaker extends OccHandle {
  IsDone(): boolean;
  Edge(): OccShape;
}

interface OccWireMaker extends OccHandle {
  Add_1(edge: OccShape): void;
  IsDone(): boolean;
  Wire(): OccShape;
}

const point = (api: OccApi, [x, y, z]: Vec3): OccHandle => new api.gp_Pnt_3(x, y, z);

/** Edge of one exact segment; null when OCC rejects it (degenerate input). */
function segmentEdge(api: OccApi, segment: CurveSegment<Vec3>): OccShape | null {
  const points = segment.points.map((p) => point(api, p));
  const handles: OccHandle[] = [...points];
  let maker: OccEdgeMaker;
  if (segment.type === 'line') {
    maker = new api.BRepBuilderAPI_MakeEdge_3(points[0], points[1]);
  } else if (segment.type === 'arc') {
    const arc = new api.GC_MakeArcOfCircle_4(points[0], points[1], points[2]);
    if (!arc.IsDone()) {
      [arc, ...handles].forEach(release);
      return null;
    }
    const trimmed = arc.Value();
    const curve = new api.Handle_Geom_Curve_2(trimmed.get());
    handles.push(arc, trimmed, curve);
    maker = new api.BRepBuilderAPI_MakeEdge_24(curve);
  } else {
    const poles = new api.TColgp_Array1OfPnt_2(1, 4);
    points.forEach((p, index) => poles.SetValue(index + 1, p));
    const bezier = new api.Geom_BezierCurve_1(poles);
    const curve = new api.Handle_Geom_Curve_2(bezier);
    handles.push(poles, curve);
    maker = new api.BRepBuilderAPI_MakeEdge_24(curve);
  }
  const edge = maker.IsDone() ? maker.Edge() : null;
  [maker, ...handles].forEach(release);
  return edge;
}

/** Wire through a connected chain; null when any edge or the wire fails. */
export function chainWire(api: OccApi, chain: ReadonlyArray<CurveSegment<Vec3>>): OccShape | null {
  const maker = new api.BRepBuilderAPI_MakeWire_1() as OccWireMaker;
  for (const segment of chain) {
    const edge = segmentEdge(api, segment);
    if (edge === null) {
      maker.delete();
      return null;
    }
    maker.Add_1(edge);
    release(edge);
  }
  const wire = maker.IsDone() ? maker.Wire() : null;
  maker.delete();
  return wire;
}

/** Planar face bounded by `outer`, minus optional `holes` (each reversed into an inner loop). */
function wireFace(
  api: OccApi,
  outer: OccShape,
  holes: ReadonlyArray<OccShape & { Reverse(): void }> = [],
): OccShape | null {
  const makeFace = new api.BRepBuilderAPI_MakeFace_15(outer, true) as OccMakeFace & {
    Add(wire: OccShape): void;
  };
  for (const hole of holes) {
    hole.Reverse();
    makeFace.Add(hole);
  }
  const face = makeFace.IsDone() ? makeFace.Face() : null;
  makeFace.delete();
  return face;
}

/**
 * Planar face of a closed 2D chain mapped into 3D by `place`. The chain is first oriented so its
 * tessellation winds counter-clockwise when `counterClockwise`, clockwise otherwise.
 */
export function chainFace(
  api: OccApi,
  curves: ReadonlyArray<CurveSegment<Vec2>>,
  place: (p: Vec2) => Vec3,
  counterClockwise: boolean,
): OccShape | null {
  const isCounterClockwise = signedArea(sampleProfile(curves)) > 0;
  const oriented = isCounterClockwise === counterClockwise ? curves : reverseChain(curves);
  const lifted = oriented.map(
    (segment) =>
      ({ type: segment.type, points: segment.points.map(place) }) as unknown as CurveSegment<Vec3>,
  );
  const wire = chainWire(api, lifted);
  if (wire === null) return null;
  const face = wireFace(api, wire);
  release(wire);
  return face;
}

/** Exact circle wire of `radius` centred at `center` in the plane normal to `normal`. */
function circleWire(
  api: OccApi,
  center: Vec3,
  normal: Vec3,
  radius: number,
): OccShape & { Reverse(): void } {
  const origin = point(api, center);
  const direction: OccHandle = new api.gp_Dir_4(...normal);
  const frame: OccHandle = new api.gp_Ax2_3(origin, direction);
  const circle: OccHandle = new api.gp_Circ_2(frame, radius);
  const edgeMaker = new api.BRepBuilderAPI_MakeEdge_8(circle) as OccEdgeMaker;
  const edge = edgeMaker.Edge();
  const wireMaker = new api.BRepBuilderAPI_MakeWire_2(edge) as OccWireMaker;
  const wire = wireMaker.Wire() as OccShape & { Reverse(): void };
  [wireMaker, edge, edgeMaker, circle, frame, direction, origin].forEach(release);
  return wire;
}

/** Section face at the path start, in the sweep start frame (normal = start tangent). */
function sectionFace(api: OccApi, entity: Extract<Entity, { kind: 'sweep' }>): OccShape | null {
  const first = entity.path[0];
  if (first === undefined) return null;
  const start = first.points[0];
  const tangent = segmentTangent(first, 0);
  const { section } = entity;
  if (section.shape === 'circle') {
    const outer = circleWire(api, start, tangent, section.radius);
    const bore = section.innerRadius;
    const holes = bore !== undefined ? [circleWire(api, start, tangent, bore)] : [];
    const face = wireFace(api, outer, holes);
    [outer, ...holes].forEach(release);
    return face;
  }
  const { normal, binormal } = sweepStartAxes(tangent);
  const place = ([x, y]: Vec2): Vec3 => add3(start, add3(scale3(normal, x), scale3(binormal, y)));
  const curves: ReadonlyArray<CurveSegment<Vec2>> =
    section.curves ??
    section.profile.map((p, i) => ({
      type: 'line' as const,
      points: [p, section.profile[(i + 1) % section.profile.length] as Vec2] as const,
    }));
  return chainFace(api, curves, place, true);
}

/** Exact swept solid in the entity's local frame (not yet placed); null when OCC fails. */
export function sweptSolid(api: OccApi, entity: Entity): OccShape | null {
  if (entity.kind !== 'sweep') return null;
  const spine = chainWire(api, entity.path);
  if (spine === null) return null;
  const face = sectionFace(api, entity);
  if (face === null) {
    release(spine);
    return null;
  }
  const pipe = new api.BRepOffsetAPI_MakePipe_2(
    spine,
    face,
    api.GeomFill_Trihedron.GeomFill_IsCorrectedFrenet,
    false,
  ) as OccHandle & { Build(): void; IsDone(): boolean; Shape(): OccShape };
  pipe.Build();
  const shape = pipe.IsDone() ? pipe.Shape() : null;
  [pipe, face, spine].forEach(release);
  return shape;
}
