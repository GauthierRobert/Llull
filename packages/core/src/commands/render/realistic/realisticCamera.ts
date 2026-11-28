/**
 * Camera of `render_realistic`: a camera entity or viewpoint as render_view resolves it (`resolveViewSetup`; a camera entity adds its depth of
 * field), else a named / custom view framed like render_view but on the drawn geometry, perspective by default.
 * @pure
 */

import type { CadDocument, Vec3 } from '../../../model/types';
import type { PathTraceCamera } from '../../../model/pathTrace';
import { boundsCenter, boundsRadius } from '../../../geometry/bounds';
import { toRadians } from '../../../lib/angle';
import { resolveViewSetup } from '../viewSetup';
import { cameraForView, type ViewName } from '../camera';
import { VIEWPORT_FOV_DEGREES } from '../../../model/viewport';
import { add3, normalize3, scale3, sub3 } from '../../../lib/vec3';
import { cameraEntityOf, cameraLens, nativeCamera } from './sceneLights';

/** Share of the picture the reference raster fits its framed half-height into (`makeProjector`). */
const FRAME_MARGIN = 0.9;

export interface CameraParams {
  readonly camera?: string | undefined;
  readonly viewpointId?: string | undefined;
  readonly view?: Exclude<ViewName, 'custom'> | undefined;
  readonly direction?: Vec3 | undefined;
  readonly target?: Vec3 | undefined;
  readonly zoom?: number | undefined;
  readonly projection?: 'orthographic' | 'perspective' | undefined;
  readonly fovDeg?: number | undefined;
}

export type CameraOutcome = { readonly camera: PathTraceCamera } | { readonly code: string; readonly message: string };

const PINHOLE = { apertureRadius: 0, focusDistance: 1 } as const;

const finiteCamera = (c: PathTraceCamera): boolean =>
  [...c.position, ...c.forward, ...c.up, c.fovY, c.orthoHeight, c.apertureRadius, c.focusDistance].every(Number.isFinite) &&
  Math.hypot(c.forward[0], c.forward[1], c.forward[2]) > 0.5;

/** A named / custom view framed on the drawn geometry `bounds` (not the document snapshot: 2D sketches and hidden layers do not count, arrays do). */
function framedView(
  params: CameraParams,
  bounds: { readonly min: Vec3; readonly max: Vec3 } | null,
  toOrthoHeight: (half: number) => number,
): CameraOutcome {
  const center = params.target ?? (bounds === null ? ([0, 0, 0] as Vec3) : boundsCenter(bounds));
  const radius = bounds === null ? 5 : Math.max(boundsRadius(bounds), 1e-6);
  const zoom = params.zoom ?? 1;
  const framed = cameraForView(params.direction !== undefined ? 'custom' : (params.view ?? 'iso'), center, radius, params.direction);
  if (params.projection === 'orthographic')
    return { camera: nativeCamera(framed.position, framed.target, framed.up, 'orthographic', 0, toOrthoHeight(radius / zoom), PINHOLE) };
  const fovDeg = params.fovDeg ?? VIEWPORT_FOV_DEGREES;
  if (!(fovDeg > 0 && fovDeg < 180)) return { code: 'VIS_CAMERA_INVALID', message: 'fovDeg must be in (0, 180)' };
  const half = Math.tan(toRadians(fovDeg) / 2);
  // render_view's perspective framing (viewSetup.ts): the scene sphere fills the view, pulled back by a fifth of its radius
  const distance = (radius * 1.2) / zoom / half + radius * 0.2;
  const eye = add3(center, scale3(normalize3(sub3(framed.position, framed.target)), distance));
  return { camera: nativeCamera(eye, center, framed.up, 'perspective', toRadians(fovDeg), toOrthoHeight(distance * half), PINHOLE) };
}

export function realisticCamera(
  doc: CadDocument,
  params: CameraParams,
  width: number,
  height: number,
  bounds: { readonly min: Vec3; readonly max: Vec3 } | null,
): CameraOutcome {
  const toOrthoHeight = (orthoHalf: number): number => ((2 * orthoHalf) / FRAME_MARGIN) * (height / Math.min(width, height));
  let outcome: CameraOutcome;
  if (params.camera === undefined && params.viewpointId === undefined) outcome = framedView(params, bounds, toOrthoHeight);
  else {
    const setup = resolveViewSetup(doc, { ...params, projection: params.projection ?? 'perspective' }, width, height);
    if ('code' in setup) return setup;
    const view = setup.view;
    if (view === undefined) return { code: 'VIS_CAMERA_INVALID', message: 'the camera or viewpoint gave no view' };
    const entity = cameraEntityOf(doc, params.camera);
    const lens = entity === undefined ? PINHOLE : cameraLens(doc, entity);
    const { position, target, up, fovDeg } = view.camera;
    outcome = {
      camera:
        fovDeg !== undefined
          ? nativeCamera(position, target, up, 'perspective', toRadians(fovDeg), toOrthoHeight(view.orthoHalf), lens)
          : nativeCamera(position, target, up, 'orthographic', 0, toOrthoHeight(view.orthoHalf), lens),
    };
  }
  if ('camera' in outcome && !finiteCamera(outcome.camera))
    return { code: 'RENDER_CAMERA_INVALID', message: 'the camera has a non-finite position, aim or field of view' };
  return outcome;
}
