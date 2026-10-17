/**
 * Face adjacency graph of the OCC face-query port (01 §5.9): per face its surface, loops (outer first), area and uv box; per edge its faces
 * and convexity.
 * Convexity at the edge mid point: the edge is walked with the material on the LEFT of face 0 (explorer orientation composes the face
 * orientation), so the inward direction of face 0 is n0 x t; face 1's outward normal n1 points against it when the edge is convex.
 * @invariant face / edge indices are those of `ShapeTopology` (`uniqueSubShapes` order)
 * @failure an edge with a single face (seam), a degenerate edge, more than two faces, anti-parallel normals -> 'unknown' ('smooth' for a seam)
 */

import type { FaceGraph, FaceGraphFace } from '@core/geometry/kernelPorts';
import type { Vec3 } from '@core/model/types';
import { explorer, type OccApi, type OccHandle, type OccPoint, type OccShape } from './occtTypes';
import { subShapeIndexer, uniqueSubShapes } from './occtTopology';
import { faceMetric } from './occtFaceMetrics';
import {
  type FaceSurfaceAdaptor,
  type Own,
  cross,
  dot,
  faceAdaptor,
  isReversed,
  norm,
  pointAndNormal,
  scaled,
  surfaceParams,
  uvOfPoint,
  uvRange,
} from './occtFaceSurface';

/** Normals closer than this (rad) are the same tangent plane. */
const SMOOTH_ANGLE = 1e-6;

type Convexity = FaceGraph['edgeConvexity'][number];

/** One use of an edge in a face loop; `reversed` is the orientation seen from the face (material on the left). */
interface EdgeUse {
  readonly edge: number;
  readonly reversed: boolean;
}

interface CurveAdaptor extends OccHandle {
  FirstParameter(): number;
  LastParameter(): number;
  D1(parameter: number, point: OccPoint, tangent: OccPoint & OccHandle): void;
}

/** Wires of `face`, outer first, as lists of edge uses. */
function faceLoops(api: OccApi, face: OccShape, indexOfEdge: (edge: OccShape) => number | undefined, own: Own): EdgeUse[][] {
  const outer = own(api.BRepTools.OuterWire(face) as OccShape);
  const loops: { outer: boolean; uses: EdgeUse[] }[] = [];
  const wires = explorer(api, face, 'TopAbs_WIRE');
  for (; wires.More(); wires.Next()) {
    const wire = own(wires.Current());
    const uses: EdgeUse[] = [];
    const edges = explorer(api, wire, 'TopAbs_EDGE');
    for (; edges.More(); edges.Next()) {
      const current = own(edges.Current());
      const edge = indexOfEdge(current);
      if (edge !== undefined) uses.push({ edge, reversed: current.Orientation_1().value === 1 });
    }
    edges.delete();
    loops.push({ outer: wire.IsSame(outer), uses });
  }
  wires.delete();
  return [...loops.filter((loop) => loop.outer), ...loops.filter((loop) => !loop.outer)].map((loop) => loop.uses);
}

/** Mid point and unit tangent (edge parameter direction) of `edge`; null for a degenerate or unevaluable edge. */
function edgeMidTangent(api: OccApi, shape: OccShape, own: Own): { point: Vec3; tangent: Vec3 } | null {
  const edge = own(api.TopoDS.Edge_1(shape) as OccShape);
  if (api.BRep_Tool.Degenerated(edge) === true) return null;
  const curve = own(new api.BRepAdaptor_Curve_2(edge) as CurveAdaptor);
  const [point, tangent] = [own(new api.gp_Pnt_1() as OccPoint), own(new api.gp_Vec_1() as OccPoint & OccHandle)];
  curve.D1((curve.FirstParameter() + curve.LastParameter()) / 2, point, tangent);
  const direction: Vec3 = [tangent.X(), tangent.Y(), tangent.Z()];
  const length = norm(direction);
  return length > 0 ? { point: [point.X(), point.Y(), point.Z()], tangent: scaled(direction, 1 / length) } : null;
}

export function faceGraph(api: OccApi, shape: OccShape, own: Own): FaceGraph | null {
  const faces = uniqueSubShapes(api, shape, 'TopAbs_FACE').map((face) => own(api.TopoDS.Face_1(own(face)) as OccShape));
  const edges = uniqueSubShapes(api, shape, 'TopAbs_EDGE').map(own);
  const indexOfEdge = subShapeIndexer(edges);
  const uses = faces.map((face) => faceLoops(api, face, indexOfEdge, own));
  const adaptors = new Map<number, FaceSurfaceAdaptor>();
  const adaptorOf = (index: number): FaceSurfaceAdaptor => {
    const known = adaptors.get(index) ?? faceAdaptor(api, faces[index] as OccShape, own);
    adaptors.set(index, known);
    return known;
  };
  const nodes: FaceGraphFace[] = faces.map((face, index) => {
    const adaptor = adaptorOf(index);
    return {
      index,
      surface: surfaceParams(api, adaptor, own),
      reversed: isReversed(face),
      area: faceMetric(api, shape, index, face).area,
      loops: (uses[index] ?? []).map((loop) => [...new Set(loop.map((use) => use.edge))]),
      uvBounds: uvRange(adaptor),
    };
  });
  const edgeUses = edges.map(() => [] as { face: number; reversed: boolean }[]);
  uses.forEach((loops, face) => loops.flat().forEach((use) => edgeUses[use.edge]?.push({ face, reversed: use.reversed })));
  const edgeFaces = edgeUses.map((list) => [...new Set(list.map((use) => use.face))].sort((a, b) => a - b));
  const edgeConvexity = edges.map((edge, index): Convexity => {
    const faceList = edgeFaces[index] ?? [];
    if (faceList.length === 1 && (edgeUses[index]?.length ?? 0) > 1) return 'smooth';
    const [first, second] = faceList;
    if (faceList.length !== 2 || first === undefined || second === undefined) return 'unknown';
    const reversed = edgeUses[index]?.find((use) => use.face === first)?.reversed ?? false;
    return convexityAt(api, edge, [first, second], reversed, own, faces, adaptorOf);
  });
  return { faces: nodes, edgeFaces, edgeConvexity };
}

function convexityAt(
  api: OccApi,
  edge: OccShape,
  [indexA, indexB]: [number, number],
  reversedInA: boolean,
  own: Own,
  faces: readonly OccShape[],
  adaptorOf: (index: number) => FaceSurfaceAdaptor,
): Convexity {
  const mid = edgeMidTangent(api, edge, own);
  if (mid === null) return 'unknown';
  const normals = [indexA, indexB].map((index) => {
    const face = faces[index] as OccShape;
    const adaptor = adaptorOf(index);
    const [u, v] = uvOfPoint(api, face, adaptor, mid.point, own);
    return pointAndNormal(api, adaptor, isReversed(face), u, v, own)?.normal ?? null;
  });
  const [nA, nB] = normals;
  if (nA === null || nB === null || nA === undefined || nB === undefined) return 'unknown';
  if (dot(nA, nB) > 0 && norm(cross(nA, nB)) < SMOOTH_ANGLE) return 'smooth';
  const inward = cross(nA, scaled(mid.tangent, reversedInA ? -1 : 1));
  const side = dot(inward, nB);
  if (Math.abs(side) < 1e-9) return 'unknown';
  return side < 0 ? 'convex' : 'concave';
}
