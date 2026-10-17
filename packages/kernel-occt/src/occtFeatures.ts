/**
 * OCC-native `feature` nodes (07 FTR §5.3, M7): a pocket as a `BRepFeat_MakePrism` cut from its sketch face, a hole as one `BRepFeat_MakeRevol` cut
 * of the revolved half-section per position. Probed on opencascade.js 1.1.1 (OCCT 7.4): both constructors, `Init` and `Perform_1` work and give
 * the exact volume; `BRepFeat_MakeCylindricalHole` / `MakeLinearForm` stay unconstructible, so ribs keep the lowering.
 * @invariant the result is the same solid as the lowered boolean (VC-FTR-25, 1e-6 relative); a floor fillet is applied by the caller on the result
 * @failure islands, more than `NATIVE_MAX_HOLES` positions, no supporting face, builder not done or an invalid result -> null (the caller lowers)
 */

import type { Vec2, Vec3 } from '@core/model/types';
import type { FeatureRecipe } from '@core/geometry/featureLowering';
import { holeToolProfile } from '@core/geometry/featureLowering';
import { frameToWorld } from '@core/geometry/featureFrame';
import { roundedOutline } from '@core/geometry/pocketOutline';
import { polygonCentroid } from '@lib/polygon';
import { add3, dot3, scale3, sub3 } from '@lib/vec3';
import type { FeatureFrame } from '@core/model/features';
import { chainFace } from './occtCurves';
import { polygonFace } from './occtShapes';
import { nearestOn } from './occtFaceDistance';
import { faceAdaptor, surfaceParams, type Own } from './occtFaceSurface';
import { uniqueSubShapes } from './occtTopology';
import type { OccApi, OccHandle, OccShape, OccValidity } from './occtTypes';

/** More positions than this are cut by ONE compound boolean (the lowering): a native cut per position grows the shape each time. */
const NATIVE_MAX_HOLES = 8;
const PARALLEL = 1 - 1e-9;

interface FeatureMaker extends OccHandle {
  Init(base: OccShape, profile: OccShape, sketch: OccShape, direction: OccHandle, fuse: number, modify: boolean): void;
  Perform_1(length: number): void;
  IsDone(): boolean;
  Shape(): OccShape;
}

const isValid = (api: OccApi, shape: OccShape, own: Own): boolean =>
  own(new api.BRepCheck_Analyzer(shape, true) as OccValidity).IsValid_2();

/** The planar face of `source` lying on the plane of `frame` that contains one of the `probes` (world points). */
function supportingFace(api: OccApi, own: Own, source: OccShape, frame: FeatureFrame, probes: readonly Vec3[]): OccShape | null {
  for (const raw of uniqueSubShapes(api, source, 'TopAbs_FACE').map(own)) {
    const face = own(api.TopoDS.Face_1(raw) as OccShape);
    const surface = surfaceParams(api, faceAdaptor(api, face, own), own);
    if (surface.type !== 'plane' || Math.abs(dot3(surface.normal, frame.normal)) < PARALLEL) continue;
    if (Math.abs(dot3(surface.normal, sub3(frame.origin, surface.origin))) > 1e-6 * (1 + Math.abs(dot3(frame.normal, frame.origin))))
      continue;
    if (probes.some((probe) => (nearestOn(api, face, probe, own)?.distance ?? Infinity) < 1e-6)) return face;
  }
  return null;
}

/** Runs one feature maker; the result is released by the caller unless it is the returned shape. */
function perform(api: OccApi, own: Own, make: (maker: FeatureMaker) => void, last: boolean): OccShape | null {
  const maker = own(new api.BRepFeat_MakeRevol_1() as FeatureMaker);
  make(maker);
  if (!maker.IsDone()) return null;
  const shape = maker.Shape();
  return last ? shape : own(shape);
}

function nativeHoles(
  api: OccApi,
  own: Own,
  source: OccShape,
  node: Extract<FeatureRecipe, { feature: 'hole' }>,
  reach: number,
): OccShape | null {
  if (node.points.length > NATIVE_MAX_HOLES || node.hole.thread?.modelled === true) return null;
  const profile = holeToolProfile(node.hole, node.extent, reach);
  if (profile === null) return null;
  let current = source;
  for (const [index, point] of node.points.entries()) {
    const origin = frameToWorld(node.frame, point);
    const place = ([radius, height]: readonly [number, number]): Vec3 =>
      add3(add3(origin, scale3(node.frame.xDir, radius)), scale3(node.frame.normal, height));
    const face = polygonFace(api, profile.map(place));
    if (face === null) return null;
    own(face);
    const axis = own(
      new api.gp_Ax1_2(
        own(new api.gp_Pnt_3(...origin) as OccHandle),
        own(new api.gp_Dir_4(...node.frame.normal) as OccHandle),
      ) as OccHandle,
    );
    const next = perform(
      api,
      own,
      (maker) => {
        maker.Init(current, face, own(new api.TopoDS_Face() as OccShape), axis, 0, true);
        maker.Perform_1(2 * Math.PI);
      },
      index === node.points.length - 1,
    );
    if (next === null) return null;
    current = next;
  }
  return current === source ? null : current;
}

function nativePocket(
  api: OccApi,
  own: Own,
  source: OccShape,
  node: Extract<FeatureRecipe, { feature: 'pocket' }>,
  reach: number,
): OccShape | null {
  const { pocket, frame } = node;
  if ((pocket.islands?.length ?? 0) > 0) return null;
  const outline = roundedOutline(pocket.outline, pocket.cornerRadius);
  if (typeof outline === 'string') return null;
  const place = (point: Vec2): Vec3 => frameToWorld(frame, point);
  const probes = [polygonCentroid(pocket.outline), ...outline.profile].map(place);
  const sketch = supportingFace(api, own, source, frame, probes);
  const profile = chainFace(api, outline.curves, place, true);
  if (sketch === null || profile === null) return null;
  own(profile);
  const length = pocket.depth === 'through' ? reach + 1e-3 * (1 + reach) : pocket.depth;
  const direction = own(new api.gp_Dir_4(...scale3(frame.normal, -1)) as OccHandle);
  const maker = own(new api.BRepFeat_MakePrism_1() as FeatureMaker);
  maker.Init(source, profile, sketch, direction, 0, true);
  maker.Perform_1(length);
  return maker.IsDone() ? maker.Shape() : null;
}

let nativeBuilds = 0;

/** Feature nodes built by the native BRepFeat makers since load (tests assert the native path ran). */
export function nativeFeatureCount(): number {
  return nativeBuilds;
}

/**
 * The cut result of `node` on `source` built with the native BRepFeat makers, or null when this node or shape needs the lowering.
 * The returned shape is NOT owned by `own`.
 */
export function nativeFeature(api: OccApi, own: Own, source: OccShape, node: FeatureRecipe, reach: number): OccShape | null {
  const result =
    node.feature === 'hole'
      ? nativeHoles(api, own, source, node, reach)
      : node.feature === 'pocket'
        ? nativePocket(api, own, source, node, reach)
        : null;
  if (result === null) return null;
  if (!isValid(api, result, own)) {
    result.delete();
    return null;
  }
  nativeBuilds++;
  return result;
}
