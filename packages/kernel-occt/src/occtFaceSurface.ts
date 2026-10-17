/**
 * Surface-level helpers of the OCC face-query port: surface parameters, uv bounds, outward normals, principal curvatures.
 * Bindings (opencascade.js 1.1.1): BRepAdaptor_Surface_2 (face, restrict), BRepLProp_SLProps_1 (adaptor, u, v, order, resolution),
 * gp_Pln / gp_Cylinder / gp_Cone / gp_Sphere / gp_Torus (Position -> gp_Ax3), ShapeAnalysis_Surface.ValueOfUV, gp_Dir_1 out parameters.
 * @invariant normals and curvature signs are relative to the OUTWARD face normal: a convex sphere has k1 = k2 = +1/r, a bore -1/r
 */

import type { SurfaceParams, SurfaceSample } from '@core/geometry/kernelPorts';
import type { FaceSurface } from '@core/geometry/kernel';
import type { Vec2, Vec3 } from '@core/model/types';
import { type OccApi, type OccHandle, type OccPoint, type OccShape } from './occtTypes';
import { surfaceKindOf } from './occtTopology';
import { release } from '@core/geometry/nativeObject';
import { cross3, scale3 } from '@lib/vec3';

/** Registers a native handle for release when the enclosing guarded operation ends. */
export type Own = <H extends OccHandle | null>(handle: H) => H;

interface Ax3 extends OccHandle {
  Location(): OccPoint;
  Direction(): OccPoint;
  XDirection(): OccPoint;
}

interface Framed extends OccHandle {
  Position(): Ax3;
  Radius?(): number;
}

type PlaneLike = Framed;
interface ConeLike extends Framed {
  Apex(): OccPoint;
  SemiAngle(): number;
}
interface TorusLike extends Framed {
  MajorRadius(): number;
  MinorRadius(): number;
}

/** BRepAdaptor_Surface restricted to the face: the uv range is the face's bounding box in parameter space. */
export interface FaceSurfaceAdaptor extends OccHandle {
  GetType(): unknown;
  FirstUParameter(): number;
  LastUParameter(): number;
  FirstVParameter(): number;
  LastVParameter(): number;
  IsUPeriodic(): boolean;
  IsVPeriodic(): boolean;
  UPeriod(): number;
  VPeriod(): number;
  Value(u: number, v: number): OccPoint;
  Plane(): PlaneLike;
  Cylinder(): Framed;
  Cone(): ConeLike;
  Sphere(): Framed;
  Torus(): TorusLike;
}

interface LocalProps extends OccHandle {
  Value(): OccPoint;
  IsNormalDefined(): boolean;
  Normal(): OccPoint;
  IsTangentUDefined(): boolean;
  TangentU(dir: OccHandle): void;
  IsCurvatureDefined(): boolean;
  IsUmbilic(): boolean;
  MaxCurvature(): number;
  MinCurvature(): number;
  CurvatureDirections(max: OccHandle, min: OccHandle): void;
}

export const vec = (point: OccPoint): Vec3 => {
  const out: Vec3 = [point.X(), point.Y(), point.Z()];
  release(point);
  return out;
};

export const norm = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);

/** Adaptor of `face` restricted to its trimmed uv box; the caller releases it (via `own`). */
export function faceAdaptor(api: OccApi, face: OccShape, own: Own): FaceSurfaceAdaptor {
  return own(new api.BRepAdaptor_Surface_2(face, true) as FaceSurfaceAdaptor);
}

/** `[uMin, uMax, vMin, vMax]` of the adaptor's face. */
export function uvRange(adaptor: FaceSurfaceAdaptor): readonly [number, number, number, number] {
  return [adaptor.FirstUParameter(), adaptor.LastUParameter(), adaptor.FirstVParameter(), adaptor.LastVParameter()];
}

/** Whether `face` is stored REVERSED (its outward normal is the surface normal flipped). */
export const isReversed = (face: OccShape): boolean => face.Orientation_1().value === 1;

export function surfaceParams(api: OccApi, adaptor: FaceSurfaceAdaptor, own: Own): SurfaceParams {
  const kind = surfaceKindOf(api, adaptor);
  const frame = (analytic: Framed): { origin: Vec3; axis: Vec3; xDir: Vec3 } => {
    const position = own(analytic.Position());
    return { origin: vec(position.Location()), axis: vec(position.Direction()), xDir: vec(position.XDirection()) };
  };
  switch (kind) {
    case 'plane': {
      const { origin, axis, xDir } = frame(own(adaptor.Plane()));
      return { type: 'plane', origin, normal: axis, xDir };
    }
    case 'cylinder': {
      const cylinder = own(adaptor.Cylinder());
      const { origin, axis, xDir } = frame(cylinder);
      return { type: 'cylinder', origin, axis, xDir, radius: cylinder.Radius?.() ?? 0 };
    }
    case 'cone': {
      const cone = own(adaptor.Cone());
      const { axis, xDir } = frame(cone);
      const opensBackwards = cone.SemiAngle() < 0; // OCC's radius shrinks along +axis: report the equivalent cone opening along +axis
      return {
        type: 'cone',
        apex: vec(cone.Apex()),
        axis: opensBackwards ? scale3(axis, -1) : axis,
        xDir,
        semiAngle: Math.abs(cone.SemiAngle()),
      };
    }
    case 'sphere': {
      const sphere = own(adaptor.Sphere());
      return { type: 'sphere', center: frame(sphere).origin, radius: sphere.Radius?.() ?? 0 };
    }
    case 'torus': {
      const torus = own(adaptor.Torus());
      const { origin, axis } = frame(torus);
      return { type: 'torus', center: origin, axis, major: torus.MajorRadius(), minor: torus.MinorRadius() };
    }
    default:
      return { type: 'other', kind: kind satisfies FaceSurface };
  }
}

/** +1 when OCC reports a convex (outward-normal) sphere with positive curvature, -1 when negative; pinned by the sphere contract test. */
const OCC_CURVATURE_SIGN = -1;

/** Local-properties evaluator of a surface adaptor at (u, v), order 2 (curvature). */
function localProps(api: OccApi, adaptor: FaceSurfaceAdaptor, u: number, v: number, own: Own): LocalProps {
  return own(new api.BRepLProp_SLProps_1(adaptor, u, v, 2, 1e-9) as LocalProps);
}

const outward = (normal: Vec3, reversed: boolean): Vec3 => (reversed ? scale3(normal, -1) : normal);

/** Point and outward unit normal at (u, v); null where the normal is undefined (a pole, a degenerate edge). */
export function pointAndNormal(
  api: OccApi,
  adaptor: FaceSurfaceAdaptor,
  reversed: boolean,
  u: number,
  v: number,
  own: Own,
): { point: Vec3; normal: Vec3 } | null {
  const props = localProps(api, adaptor, u, v, own);
  if (!props.IsNormalDefined()) return null;
  return { point: vec(props.Value()), normal: outward(vec(props.Normal()), reversed) };
}

/**
 * Curvature sample at (u, v). OCC's signed curvatures are relative to the surface normal and positive when the surface bends
 * AWAY from it; the port reports them relative to the outward normal (convex positive), so a flip swaps the roles of max / min.
 */
export function surfaceSample(api: OccApi, adaptor: FaceSurfaceAdaptor, reversed: boolean, u: number, v: number, own: Own): SurfaceSample {
  const props = localProps(api, adaptor, u, v, own);
  const point = vec(props.Value());
  const zero: Vec3 = [0, 0, 0];
  const degenerate = { u, v, point, normal: zero, k1: 0, k2: 0, dir1: zero, dir2: zero, gaussian: 0, mean: 0, degenerate: true };
  if (!props.IsNormalDefined() || !props.IsCurvatureDefined()) return degenerate;
  const normal = outward(vec(props.Normal()), reversed);
  const [kMax, kMin] = [props.MaxCurvature(), props.MinCurvature()];
  const [maxDir, minDir] = [own(new api.gp_Dir_1() as OccPoint), own(new api.gp_Dir_1() as OccPoint)];
  let dirMax: Vec3;
  let dirMin: Vec3;
  if (props.IsUmbilic()) {
    if (!props.IsTangentUDefined()) return { ...degenerate, normal };
    props.TangentU(maxDir);
    dirMax = [maxDir.X(), maxDir.Y(), maxDir.Z()];
    dirMin = cross3(normal, dirMax);
  } else {
    props.CurvatureDirections(maxDir, minDir);
    dirMax = [maxDir.X(), maxDir.Y(), maxDir.Z()];
    dirMin = [minDir.X(), minDir.Y(), minDir.Z()];
  }
  const flip = OCC_CURVATURE_SIGN * (reversed ? -1 : 1) < 0;
  const [k1, k2] = flip ? [-kMin, -kMax] : [kMax, kMin];
  return {
    u,
    v,
    point,
    normal,
    k1,
    k2,
    dir1: flip ? dirMin : dirMax,
    dir2: flip ? dirMax : dirMin,
    gaussian: k1 * k2,
    mean: (k1 + k2) / 2,
    degenerate: false,
  };
}

/**
 * (u, v) of the surface point nearest to `point`, shifted into the face's range on periodic directions (ShapeAnalysis_Surface.ValueOfUV).
 */
export function uvOfPoint(api: OccApi, face: OccShape, adaptor: FaceSurfaceAdaptor, point: Vec3, own: Own): Vec2 {
  const surface = own(api.BRep_Tool.Surface_2(face) as OccHandle);
  const analysis = own(
    new api.ShapeAnalysis_Surface(surface) as OccHandle & { ValueOfUV(p: OccHandle, tolerance: number): OccPoint & OccHandle },
  );
  const target = own(new api.gp_Pnt_3(point[0], point[1], point[2]) as OccHandle);
  const uv = own(analysis.ValueOfUV(target, 1e-9));
  const [uMin, uMax, vMin, vMax] = uvRange(adaptor);
  return [
    adaptor.IsUPeriodic() ? wrapInto(uv.X(), uMin, uMax, adaptor.UPeriod()) : uv.X(),
    adaptor.IsVPeriodic() ? wrapInto(uv.Y(), vMin, vMax, adaptor.VPeriod()) : uv.Y(),
  ];
}

/** `value` shifted by whole periods into [min, max] when possible (else unchanged). */
function wrapInto(value: number, min: number, max: number, period: number): number {
  if (!(period > 0) || (value >= min - 1e-9 && value <= max + 1e-9)) return value;
  const shifted = value + Math.round((min + max) / 2 / period - value / period) * period;
  return shifted >= min - 1e-9 && shifted <= max + 1e-9 ? shifted : value;
}
