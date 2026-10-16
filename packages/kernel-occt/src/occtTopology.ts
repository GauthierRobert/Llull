/**
 * Exact B-rep topology of an OCC shape: unique sub-shapes (an edge shared by two faces counted once,
 * in explorer order — the numbering `fillet` / `chamfer` select by), face surface types and areas,
 * edge curve types, lengths and points, seam / degenerate flags, solid volume.
 */

import type { EdgeCurve, FaceSurface, ShapeEdge, ShapeFace, ShapeTopology } from '@core/geometry/kernel';
import type { Vec3 } from '@core/model/types';
import { release } from '@core/geometry/nativeObject';
import { explorer, type OccApi, type OccHandle, type OccPoint, type OccShape } from './occtTypes';

type SubShapeKind = 'TopAbs_SOLID' | 'TopAbs_FACE' | 'TopAbs_EDGE' | 'TopAbs_VERTEX';

const HASH_BOUND = 1 << 30;

/**
 * Distinct sub-shapes of `kind` (IsSame: same TShape and location, any orientation), in explorer
 * order. The caller owns (releases) every returned shape.
 */
export function uniqueSubShapes(api: OccApi, shape: OccShape, kind: SubShapeKind): OccShape[] {
  const unique: OccShape[] = [];
  const buckets = new Map<number, OccShape[]>();
  const exp = explorer(api, shape, kind);
  for (; exp.More(); exp.Next()) {
    const current = exp.Current();
    const hash = current.HashCode(HASH_BOUND);
    const bucket = buckets.get(hash) ?? [];
    if (bucket.some((seen) => seen.IsSame(current))) {
      release(current);
      continue;
    }
    bucket.push(current);
    buckets.set(hash, bucket);
    unique.push(current);
  }
  exp.delete();
  return unique;
}

interface GProps extends OccHandle {
  Mass(): number;
}

const CURVES: ReadonlyArray<readonly [string, EdgeCurve]> = [
  ['GeomAbs_Line', 'line'],
  ['GeomAbs_Circle', 'circle'],
  ['GeomAbs_Ellipse', 'ellipse'],
  ['GeomAbs_BSplineCurve', 'bspline'],
  ['GeomAbs_BezierCurve', 'bspline'],
];

const SURFACES: ReadonlyArray<readonly [string, FaceSurface]> = [
  ['GeomAbs_Plane', 'plane'],
  ['GeomAbs_Cylinder', 'cylinder'],
  ['GeomAbs_Cone', 'cone'],
  ['GeomAbs_Sphere', 'sphere'],
  ['GeomAbs_Torus', 'torus'],
  ['GeomAbs_BSplineSurface', 'bspline'],
  ['GeomAbs_BezierSurface', 'bspline'],
  ['GeomAbs_SurfaceOfRevolution', 'revolution'],
  ['GeomAbs_SurfaceOfExtrusion', 'extrusion'],
];

function classify<T extends string>(
  enumeration: Record<string, unknown>,
  table: ReadonlyArray<readonly [string, T]>,
  type: unknown,
  fallback: T,
): T {
  return table.find(([name]) => enumeration[name] === type)?.[1] ?? fallback;
}

function pointAt(adaptor: { Value(u: number): OccPoint }, parameter: number): Vec3 {
  const point = adaptor.Value(parameter);
  const xyz: Vec3 = [point.X(), point.Y(), point.Z()];
  release(point);
  return xyz;
}

/** Number of distinct faces each unique edge bounds (1 = a seam), indexed like `edges`. */
function adjacentFaceCounts(api: OccApi, faces: readonly OccShape[], edges: readonly OccShape[]): number[] {
  const buckets = new Map<number, number[]>();
  edges.forEach((edge, index) => {
    const hash = edge.HashCode(HASH_BOUND);
    buckets.set(hash, [...(buckets.get(hash) ?? []), index]);
  });
  const facesOf = edges.map(() => new Set<number>());
  faces.forEach((face, faceIndex) => {
    const exp = explorer(api, face, 'TopAbs_EDGE');
    for (; exp.More(); exp.Next()) {
      const current = exp.Current();
      const match = buckets.get(current.HashCode(HASH_BOUND))?.find((index) => edges[index]?.IsSame(current));
      if (match !== undefined) facesOf[match]?.add(faceIndex);
      release(current);
    }
    exp.delete();
  });
  return facesOf.map((set) => set.size);
}

/** Samples per curved edge (`ShapeEdge.samples`): enough for `edgesNear` to tell arcs apart. */
const EDGE_SAMPLES = 16;

function edgeInfo(api: OccApi, shape: OccShape, index: number, faceCount: number): ShapeEdge {
  const edge = api.TopoDS.Edge_1(shape) as OccShape;
  const degenerate = api.BRep_Tool.Degenerated(edge) === true;
  if (degenerate) {
    const vertex = api.TopoDS.Vertex_1(api.TopExp.FirstVertex(edge, false)) as OccShape;
    const point = api.BRep_Tool.Pnt(vertex) as OccPoint;
    const at: Vec3 = [point.X(), point.Y(), point.Z()];
    [point, vertex, edge].forEach(release);
    return { index, curve: 'other', length: 0, start: at, end: at, mid: at, seam: false, degenerate };
  }
  const adaptor = new api.BRepAdaptor_Curve_2(edge) as OccHandle & {
    GetType(): unknown;
    FirstParameter(): number;
    LastParameter(): number;
    Value(u: number): OccPoint;
  };
  const [first, last] = [adaptor.FirstParameter(), adaptor.LastParameter()];
  const props = new api.GProp_GProps_1() as GProps;
  api.BRepGProp.LinearProperties(edge, props, false, false);
  const curve = classify(api.GeomAbs_CurveType, CURVES, adaptor.GetType(), 'other');
  const info: ShapeEdge = {
    index,
    curve,
    length: props.Mass(),
    start: pointAt(adaptor, first),
    end: pointAt(adaptor, last),
    mid: pointAt(adaptor, (first + last) / 2),
    ...(curve === 'line'
      ? {}
      : { samples: Array.from({ length: EDGE_SAMPLES + 1 }, (_, k) => pointAt(adaptor, first + ((last - first) * k) / EDGE_SAMPLES)) }),
    seam: faceCount === 1,
    degenerate,
  };
  [props, adaptor, edge].forEach(release);
  return info;
}

interface AxisHandle extends OccHandle {
  Location(): OccPoint;
  Direction(): OccPoint;
}

interface AnalyticSurface extends OccHandle {
  Axis(): AxisHandle;
  Radius?(): number;
  Direct?(): boolean;
}

interface SurfaceAdaptor extends OccHandle {
  GetType(): unknown;
  FirstVParameter(): number;
  LastVParameter(): number;
  Plane(): AnalyticSurface;
  Cylinder(): AnalyticSurface;
  Cone(): AnalyticSurface;
  AxeOfRevolution(): AxisHandle;
}

type FaceGeometry = Pick<Mutable<ShapeFace>, 'axis' | 'normal' | 'convex'>;
type Mutable<T> = { -readonly [K in keyof T]?: T[K] };

const FORWARD = 0;

function vectorOf(handle: OccPoint): Vec3 {
  const out: Vec3 = [handle.X(), handle.Y(), handle.Z()];
  release(handle);
  return out;
}

/** Axis (cylinder / cone / revolution), outward plane normal and convexity of an analytic face (TR-FPR-02); {} for other surfaces. */
function faceGeometry(face: OccShape, adaptor: SurfaceAdaptor, surface: FaceSurface): FaceGeometry {
  const forward = (face.Orientation_1().value as number) === FORWARD;
  if (surface === 'plane') {
    const plane = adaptor.Plane();
    const axis = plane.Axis();
    const [x, y, z] = vectorOf(axis.Direction());
    [axis, plane].forEach(release);
    const sign = forward ? 1 : -1;
    return { normal: [x * sign, y * sign, z * sign] };
  }
  if (surface === 'cylinder' || surface === 'cone') {
    const analytic = surface === 'cylinder' ? adaptor.Cylinder() : adaptor.Cone();
    const axis = analytic.Axis();
    const origin = vectorOf(axis.Location());
    const direction = vectorOf(axis.Direction());
    const radius = surface === 'cylinder' ? analytic.Radius?.() : undefined;
    const direct = analytic.Direct?.() ?? true;
    [axis, analytic].forEach(release);
    const span: readonly [number, number] | undefined =
      surface === 'cylinder' ? [adaptor.FirstVParameter(), adaptor.LastVParameter()] : undefined;
    return {
      axis: { origin, direction, ...(radius === undefined ? {} : { radius }), ...(span === undefined ? {} : { span }) },
      convex: forward === direct,
    };
  }
  if (surface === 'revolution') {
    const axis = adaptor.AxeOfRevolution();
    const info = { origin: vectorOf(axis.Location()), direction: vectorOf(axis.Direction()) };
    release(axis);
    return { axis: info };
  }
  return {};
}

function faceInfo(api: OccApi, shape: OccShape, index: number): ShapeFace {
  const face = api.TopoDS.Face_1(shape) as OccShape;
  const adaptor = new api.BRepAdaptor_Surface_2(face, true) as SurfaceAdaptor;
  const props = new api.GProp_GProps_1() as GProps;
  api.BRepGProp.SurfaceProperties_1(face, props, false, false);
  const surface = classify(api.GeomAbs_SurfaceType, SURFACES, adaptor.GetType(), 'other');
  const info: ShapeFace = { index, surface, area: props.Mass(), ...faceGeometry(face, adaptor, surface) };
  [props, adaptor, face].forEach(release);
  return info;
}

/** Faces, edges (fillet numbering), vertex and solid counts, and volume of `shape`. */
export function shapeTopology(api: OccApi, shape: OccShape): ShapeTopology {
  const count = (kind: SubShapeKind): number => {
    const subShapes = uniqueSubShapes(api, shape, kind);
    subShapes.forEach(release);
    return subShapes.length;
  };
  const faces = uniqueSubShapes(api, shape, 'TopAbs_FACE');
  const edges = uniqueSubShapes(api, shape, 'TopAbs_EDGE');
  const faceCounts = adjacentFaceCounts(api, faces, edges);
  const volumeProps = new api.GProp_GProps_1() as GProps;
  api.BRepGProp.VolumeProperties_1(shape, volumeProps, false, false, false);
  const topology: ShapeTopology = {
    solids: count('TopAbs_SOLID'),
    faces: faces.map((face, index) => faceInfo(api, face, index)),
    edges: edges.map((edge, index) => edgeInfo(api, edge, index, faceCounts[index] ?? 0)),
    vertices: count('TopAbs_VERTEX'),
    volume: Math.abs(volumeProps.Mass()),
  };
  [...faces, ...edges, volumeProps].forEach(release);
  return topology;
}
