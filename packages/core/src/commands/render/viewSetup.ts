/**
 * Camera set-up of render_view beyond the framed orthographic named views (plant 09 VIS-M4 slice): a saved viewpoint (perspective or
 * orthographic BCF camera) or `projection: 'perspective'` on a named view / direction. Perspective renders are raster-only.
 * @pure
 */

import type { CadDocument, CameraEntity, Vec3 } from '../../model/types';
import { cameraVerticalFov } from '../../model/sceneKinds';
import { aimDirection, upDirection } from '../../lib/lookAt';
import { toDegrees } from '../../lib/angle';
import { cameraFieldsProblem } from '../scene/validate';
import type { ViewpointCamera } from '../../model/review';
import { VIEWPORT_FOV_DEGREES } from '../../model/viewport';
import { boundsCenter, boundsRadius } from '../../geometry/bounds';
import { ORIGIN, add3, scale3, sub3, normalize3, len3 } from '../../lib/vec3';
import { computeSceneSnapshot } from '../inspect/scene';
import { type ViewName, cameraForView } from './camera';
import type { RenderOptions } from './types';

type ExplicitView = NonNullable<RenderOptions['view']>;

const tuple = (v: Vec3): [number, number, number] => [v[0], v[1], v[2]];

/** The render camera of a viewpoint camera on a `width` × `height` image. */
export function viewpointView(camera: ViewpointCamera, width: number, height: number, sceneCenter: Vec3): ExplicitView {
  const { eye, direction, up } = camera;
  const target = add3(eye, direction);
  if (camera.projection === 'perspective') {
    const reach = Math.max(len3(sub3(sceneCenter, eye)), 1e-6);
    return {
      camera: { position: tuple(eye), target: tuple(target), up: tuple(up), fovDeg: camera.fovDeg },
      orthoHalf: reach * Math.tan((camera.fovDeg * Math.PI) / 360),
    };
  }
  return {
    camera: { position: tuple(eye), target: tuple(target), up: tuple(up) },
    orthoHalf: (camera.viewHeight * Math.min(width, height) * 0.45) / height,
  };
}

interface ViewParams {
  readonly view?: ViewName | undefined;
  readonly direction?: Vec3 | undefined;
  readonly target?: Vec3 | undefined;
  readonly zoom?: number | undefined;
  readonly projection?: 'orthographic' | 'perspective' | undefined;
  readonly fovDeg?: number | undefined;
  readonly viewpointId?: string | undefined;
  readonly camera?: string | undefined;
}

export type ViewSetup =
  | { readonly projection: 'orthographic' | 'perspective'; readonly view?: ExplicitView }
  | { readonly code: ViewSetupCode; readonly message: string };

type ViewSetupCode =
  | 'VIS_VIEWPOINT_NOT_FOUND'
  | 'VIS_CAMERA_INVALID'
  | 'SCENE_CAMERA_NOT_FOUND'
  | 'SCENE_NOT_A_CAMERA'
  | 'SCENE_CAMERA_INVALID';

/** Perspective view from a camera entity: its position, aim and up, and the vertical field of view of its sensor / focal length. */
function cameraEntityView(entity: CameraEntity, center: Vec3): ExplicitView | string {
  const problem = cameraFieldsProblem({ ...entity });
  if (problem !== null) return problem;
  const fovDeg = toDegrees(cameraVerticalFov(entity));
  const camera: ViewpointCamera = {
    projection: 'perspective',
    eye: entity.position,
    direction: aimDirection(entity.rotation),
    up: upDirection(entity.rotation),
    fovDeg,
  };
  return viewpointView(camera, 0, 0, center);
}

/** Explicit camera for a viewpoint or a perspective view; no `view` = the historical framed orthographic camera. */
export function resolveViewSetup(doc: CadDocument, params: ViewParams, width: number, height: number): ViewSetup {
  const snapshot = computeSceneSnapshot(doc);
  const center = params.target ?? (snapshot.bounds ? boundsCenter(snapshot.bounds) : ORIGIN);
  if (params.camera !== undefined) {
    if (params.viewpointId !== undefined) return { code: 'VIS_CAMERA_INVALID', message: 'give camera or viewpointId, not both' };
    const entity = doc.entities[params.camera];
    if (entity === undefined) return { code: 'SCENE_CAMERA_NOT_FOUND', message: `no entity '${params.camera}'` };
    if (entity.kind !== 'camera')
      return { code: 'SCENE_NOT_A_CAMERA', message: `entity '${params.camera}' is kind '${entity.kind}', not a camera` };
    const view = cameraEntityView(entity, center);
    if (typeof view === 'string') return { code: 'SCENE_CAMERA_INVALID', message: `camera '${params.camera}': ${view}` };
    return { projection: 'perspective', view };
  }
  if (params.viewpointId !== undefined) {
    const viewpoint = doc.review?.viewpoints[params.viewpointId];
    if (viewpoint === undefined) return { code: 'VIS_VIEWPOINT_NOT_FOUND', message: `no viewpoint '${params.viewpointId}'` };
    return { projection: viewpoint.camera.projection, view: viewpointView(viewpoint.camera, width, height, center) };
  }
  if (params.projection !== 'perspective') return { projection: 'orthographic' };
  const fovDeg = params.fovDeg ?? VIEWPORT_FOV_DEGREES;
  if (!(fovDeg > 0 && fovDeg < 180)) return { code: 'VIS_CAMERA_INVALID', message: 'fovDeg must be in (0, 180)' };
  const radius = snapshot.bounds ? boundsRadius(snapshot.bounds) : 5;
  const framed = cameraForView(params.direction ? 'custom' : (params.view ?? 'iso'), center, radius, params.direction);
  const toEye = normalize3(sub3(framed.position, framed.target));
  const distance = (radius * 1.2) / (params.zoom ?? 1) / Math.tan((fovDeg * Math.PI) / 360) + radius * 0.2;
  const eye = add3(center, scale3(toEye, distance));
  return {
    projection: 'perspective',
    view: {
      camera: { position: tuple(eye), target: tuple(center), up: framed.up, fovDeg },
      orthoHalf: distance * Math.tan((fovDeg * Math.PI) / 360),
    },
  };
}
