/**
 * Point-to-shape distance of the OCC face-query port (BRepExtrema_DistShapeShape from a vertex; BRepClass3d_SolidClassifier for the sign).
 * @invariant a solid is measured against its SHELLS: BRepExtrema reports 0 for a point inside a solid, the port wants the distance to the boundary
 * @failure unsolved extrema -> null
 */

import type { Vec3 } from '@core/model/types';
import { release } from '@core/geometry/nativeObject';
import { type OccApi, type OccHandle, type OccPoint, type OccShape } from './occtTypes';
import { subShapeIndexer, uniqueSubShapes } from './occtTopology';
import { type Own, vec } from './occtFaceSurface';

interface Extrema extends OccHandle {
  LoadS1(shape: OccShape): boolean;
  LoadS2(shape: OccShape): boolean;
  Perform(): boolean;
  IsDone(): boolean;
  Value(): number;
  PointOnShape2(index: number): OccPoint;
  SupportOnShape2(index: number): OccShape;
}

interface SolidClassifier extends OccHandle {
  Load(shape: OccShape): void;
  Perform(point: OccHandle, tolerance: number): void;
  State(): unknown;
}

export interface Nearest {
  readonly distance: number;
  readonly point: Vec3;
  /** The sub-shape of the target carrying the nearest point (a face, edge or vertex). */
  readonly support: OccShape;
}

/** Nearest point of `target` to `point`; null when the extrema algorithm does not solve. */
export function nearestOn(api: OccApi, target: OccShape, point: Vec3, own: Own): Nearest | null {
  const location = own(new api.gp_Pnt_3(point[0], point[1], point[2]) as OccHandle);
  const maker = own(new api.BRepBuilderAPI_MakeVertex(location) as OccHandle & { Vertex(): OccShape });
  const extrema = own(new api.BRepExtrema_DistShapeShape_1() as Extrema);
  extrema.LoadS1(own(maker.Vertex()));
  extrema.LoadS2(target);
  if (!extrema.Perform() || !extrema.IsDone()) return null;
  return { distance: extrema.Value(), point: vec(extrema.PointOnShape2(1)), support: own(extrema.SupportOnShape2(1)) };
}

/** Whether `point` is strictly inside one of the solids of `shape`. */
function insideSolid(api: OccApi, solids: readonly OccShape[], point: Vec3, own: Own): boolean {
  const location = own(new api.gp_Pnt_3(point[0], point[1], point[2]) as OccHandle);
  return solids.some((solid) => {
    const classifier = own(new api.BRepClass3d_SolidClassifier_1() as SolidClassifier);
    classifier.Load(solid);
    classifier.Perform(location, 1e-7);
    return classifier.State() === api.TopAbs_State.TopAbs_IN;
  });
}

export interface PointDistance {
  readonly distance: number;
  readonly signed: number;
  readonly face: number;
}

/** Index of the face carrying `support`: itself, or the only face of a seam edge; -1 for a boundary edge between faces or a vertex. */
function supportingFace(
  api: OccApi,
  support: OccShape,
  faces: readonly OccShape[],
  faceIndex: (face: OccShape) => number | undefined,
): number {
  const type = support.ShapeType();
  if (type === api.TopAbs_ShapeEnum.TopAbs_FACE) return faceIndex(support) ?? -1;
  if (type !== api.TopAbs_ShapeEnum.TopAbs_EDGE) return -1;
  const owners = faces.flatMap((face, index) => {
    const edges = uniqueSubShapes(api, face, 'TopAbs_EDGE');
    try {
      return edges.some((edge) => edge.IsSame(support)) ? [index] : [];
    } finally {
      edges.forEach(release);
    }
  });
  return owners.length === 1 ? (owners[0] ?? -1) : -1;
}

/** Distance of each point to the shape's boundary, negative inside a solid, with the nearest face index (-1 on an edge / vertex). */
export function pointDistances(api: OccApi, shape: OccShape, points: readonly Vec3[], own: Own): readonly PointDistance[] | null {
  const faces = uniqueSubShapes(api, shape, 'TopAbs_FACE').map(own);
  const faceIndex = subShapeIndexer(faces);
  const solids = uniqueSubShapes(api, shape, 'TopAbs_SOLID').map(own);
  const shells = uniqueSubShapes(api, shape, 'TopAbs_SHELL').map(own);
  const targets = shells.length > 0 ? shells : [shape];
  const out: PointDistance[] = [];
  for (const point of points) {
    let best: Nearest | null = null;
    for (const target of targets) {
      const candidate = nearestOn(api, target, point, own);
      if (candidate === null) return null;
      if (best === null || candidate.distance < best.distance) best = candidate;
    }
    if (best === null) return null;
    out.push({
      distance: best.distance,
      signed: insideSolid(api, solids, point, own) ? -best.distance : best.distance,
      face: supportingFace(api, best.support, faces, faceIndex),
    });
  }
  return out;
}
