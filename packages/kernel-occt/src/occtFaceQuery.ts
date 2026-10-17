/**
 * OCC implementation of the face-query port (01 §5.9, TR-KRN-90): `FaceQueryOps<OccShape>` for `kernelFromOps`.
 * Bindings (opencascade.js 1.1.1 = OCCT 7.4): BRepAdaptor_Surface_2, BRepGProp.SurfaceProperties_1, BRepLProp_SLProps_1,
 * BRepClass_FaceClassifier_1 (Perform_1 takes a gp_Pnt2d), ShapeAnalysis_Surface.ValueOfUV, BRepExtrema_DistShapeShape_1, BRepTools.OuterWire.
 * @invariant face / edge indices are those of `ShapeTopology` (`uniqueSubShapes` order); lengths and areas in document units
 * @failure index out of range, undefined normal or an unsolved extrema -> null for that call (a per-point null for `projectOnFace`)
 * @failure `tessellateFace`, `edgeSamples`, `edgeContinuity` and `bspline` are not implemented by this kernel -> always null
 */

import type { FaceQueryOps } from '@core/geometry/shapeKernel';
import type { FaceDetail, FaceProjection } from '@core/geometry/kernelPorts';
import type { FaceSurface } from '@core/geometry/kernel';
import type { Vec2, Vec3 } from '@core/model/types';
import { type OccApi, type OccHandle, type OccShape } from './occtTypes';
import { subShapeAt, surfaceKindOf, uniqueSubShapes } from './occtTopology';
import { nearestOn, pointDistances } from './occtFaceDistance';
import { faceGraph } from './occtFaceGraph';
import { faceMetric } from './occtFaceMetrics';
import {
  type FaceSurfaceAdaptor,
  type Own,
  faceAdaptor,
  isReversed,
  norm,
  pointAndNormal,
  surfaceParams,
  surfaceSample,
  uvOfPoint,
  uvRange,
  vec,
} from './occtFaceSurface';
import { dot3, scale3, sub3 } from '@lib/vec3';

/** Same signature as `occtKernel`'s `guarded`: runs `body`, maps an OCC exception to null and frees every handle passed to `own`. */
export type Guarded = <T>(operation: 'fragile' | 'refusal', body: (own: Own) => T | null) => T | null;

const DEFAULT_SAMPLES = 64;
/** Cap of the uv grid of `faceSamples({ nu, nv })`. */
const MAX_GRID_POINTS = 4096;
const DEFAULT_CONTAINS_TOLERANCE = 1e-6;

interface FaceClassifier extends OccHandle {
  Perform_1(face: OccShape, uv: OccHandle, tolerance: number): void;
  State(): unknown;
}

/** Runs `body` on the `index`-th unique face (ShapeTopology numbering); null when `index` is not a face index. */
function withFace<T>(api: OccApi, shape: OccShape, index: number, own: Own, body: (face: OccShape) => T | null): T | null {
  if (!Number.isInteger(index) || index < 0) return null;
  const face = subShapeAt(api, shape, 'TopAbs_FACE', index);
  return face === null ? null : body(own(api.TopoDS.Face_1(own(face)) as OccShape));
}

/** Up to `count` points inside the trimmed face: cell centres of a uv grid kept when the face classifier says IN, thinned evenly. */
function interiorSamples(api: OccApi, face: OccShape, adaptor: FaceSurfaceAdaptor, count: number, own: Own): Vec3[] {
  const [uMin, uMax, vMin, vMax] = uvRange(adaptor);
  if (count <= 0 || ![uMin, uMax, vMin, vMax].every(Number.isFinite)) return [];
  const side = Math.max(4, Math.ceil(Math.sqrt(count) * 2));
  const classifier = own(new api.BRepClass_FaceClassifier_1() as FaceClassifier);
  const inside: Vec2[] = [];
  for (let i = 0; i < side; i++) {
    for (let j = 0; j < side; j++) {
      const uv: Vec2 = [uMin + ((uMax - uMin) * (i + 0.5)) / side, vMin + ((vMax - vMin) * (j + 0.5)) / side];
      classifier.Perform_1(face, own(new api.gp_Pnt2d_3(uv[0], uv[1]) as OccHandle), 1e-7);
      if (classifier.State() === api.TopAbs_State.TopAbs_IN) inside.push(uv);
    }
  }
  const step = inside.length / Math.min(count, inside.length || 1);
  const chosen = inside.length <= count ? inside : Array.from({ length: count }, (_, k) => inside[Math.floor(k * step)] as Vec2);
  return chosen.map(([u, v]) => vec(adaptor.Value(u, v)));
}

function faceDetail(api: OccApi, solid: OccShape, face: OccShape, index: number, samples: number, own: Own): FaceDetail {
  const adaptor = faceAdaptor(api, face, own);
  const kind: FaceSurface = surfaceKindOf(api, adaptor);
  const metric = faceMetric(api, solid, index, face);
  const { centroid } = metric;
  const surface = surfaceParams(api, adaptor, own);
  const sign = isReversed(face) ? -1 : 1;
  const extra = ((): Pick<FaceDetail, 'normal' | 'axis' | 'radius'> => {
    switch (surface.type) {
      case 'plane':
        return { normal: scale3(surface.normal, sign) };
      case 'cylinder':
        return { axis: { origin: surface.origin, dir: surface.axis }, radius: surface.radius };
      case 'cone': {
        const toCentroid = sub3(centroid, surface.apex);
        const along = dot3(toCentroid, surface.axis);
        return { axis: { origin: surface.apex, dir: surface.axis }, radius: norm(sub3(toCentroid, scale3(surface.axis, along))) };
      }
      case 'sphere':
        return { axis: { origin: surface.center, dir: [0, 0, 1] }, radius: surface.radius };
      case 'torus':
        return { axis: { origin: surface.center, dir: surface.axis }, radius: surface.minor };
      default:
        return {};
    }
  })();
  return { index, surface: kind, area: metric.area, centroid, ...extra, samples: interiorSamples(api, face, adaptor, samples, own) };
}

/** Uv list of `faceSamples`: explicit pairs, or the cell centres of an `nu` x `nv` grid over the face's uv box. */
function uvList(
  adaptor: FaceSurfaceAdaptor,
  request: ReadonlyArray<readonly [number, number]> | { readonly nu: number; readonly nv: number },
): Array<readonly [number, number]> | null {
  if (Array.isArray(request)) return request.length <= MAX_GRID_POINTS ? request.slice() : null;
  const { nu, nv } = request as { nu: number; nv: number };
  if (!Number.isInteger(nu) || !Number.isInteger(nv) || nu < 1 || nv < 1 || nu * nv > MAX_GRID_POINTS) return null;
  const [uMin, uMax, vMin, vMax] = uvRange(adaptor);
  if (![uMin, uMax, vMin, vMax].every(Number.isFinite)) return null;
  const grid: Array<readonly [number, number]> = [];
  for (let i = 0; i < nu; i++)
    for (let j = 0; j < nv; j++) grid.push([uMin + ((uMax - uMin) * (i + 0.5)) / nu, vMin + ((vMax - vMin) * (j + 0.5)) / nv]);
  return grid;
}

function project(api: OccApi, face: OccShape, point: Vec3, own: Own): FaceProjection | null {
  const nearest = nearestOn(api, face, point, own);
  if (nearest === null) return null;
  const adaptor = faceAdaptor(api, face, own);
  const uv = uvOfPoint(api, face, adaptor, nearest.point, own);
  const local = pointAndNormal(api, adaptor, isReversed(face), uv[0], uv[1], own);
  return local === null ? null : { point: nearest.point, normal: local.normal, uv, distance: nearest.distance };
}

export function occtFaceQueryOps(api: OccApi, guarded: Guarded): FaceQueryOps<OccShape> {
  return {
    faceDetails: (shape, options) =>
      guarded('fragile', (own) => {
        const samples = Math.max(0, Math.floor(options?.samples ?? DEFAULT_SAMPLES));
        const faces = uniqueSubShapes(api, shape, 'TopAbs_FACE').map(own);
        return faces.map((face, index) => faceDetail(api, shape, own(api.TopoDS.Face_1(face) as OccShape), index, samples, own));
      }),
    faceContains: (shape, index, point, tolerance) =>
      guarded('fragile', (own) =>
        withFace(api, shape, index, own, (face) => {
          const nearest = nearestOn(api, face, point, own);
          return nearest === null ? null : nearest.distance <= (tolerance ?? DEFAULT_CONTAINS_TOLERANCE);
        }),
      ),
    faceGraph: (shape) => guarded('fragile', (own) => faceGraph(api, shape, own)),
    faceGeometry: (shape, index) =>
      guarded('fragile', (own) =>
        withFace(api, shape, index, own, (face) => {
          const adaptor = faceAdaptor(api, face, own);
          const [uMin, uMax, vMin, vMax] = uvRange(adaptor);
          return {
            surface: surfaceParams(api, adaptor, own),
            uvBounds: [
              [uMin, vMin],
              [uMax, vMax],
            ] as const,
          };
        }),
      ),
    projectOnFace: (shape, index, points) =>
      guarded('fragile', (own) => withFace(api, shape, index, own, (face) => points.map((point) => project(api, face, point, own)))),
    evaluateFace: (shape, index, uv) =>
      guarded('fragile', (own) =>
        withFace(api, shape, index, own, (face) => {
          const adaptor = faceAdaptor(api, face, own);
          const reversed = isReversed(face);
          const evaluated = uv.map(([u, v]) => pointAndNormal(api, adaptor, reversed, u, v, own));
          return evaluated.every((entry) => entry !== null) ? (evaluated as { point: Vec3; normal: Vec3 }[]) : null;
        }),
      ),
    tessellateFace: () => null,
    faceSamples: (shape, index, request) =>
      guarded('fragile', (own) =>
        withFace(api, shape, index, own, (face) => {
          const adaptor = faceAdaptor(api, face, own);
          const list = uvList(adaptor, request);
          const reversed = isReversed(face);
          return list === null ? null : list.map(([u, v]) => surfaceSample(api, adaptor, reversed, u, v, own));
        }),
      ),
    edgeSamples: () => null,
    edgeContinuity: () => null,
    distance: (shape, points) => guarded('fragile', (own) => pointDistances(api, shape, points, own)),
    bspline: () => null,
  };
}
