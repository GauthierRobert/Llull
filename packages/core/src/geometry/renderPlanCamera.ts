/**
 * Camera and frustum of the render plan (plant 09 VIS §5.3): a viewpoint or a named view framed on the scene as a `PlanCamera`, and its
 * inward-facing frustum planes for instance culling. Pure.
 * @invariant frustum planes have unit normals pointing inside; no far plane (distance is handled by the pixel cull)
 */

import type { Vec3 } from '../model/vectors';
import type { ViewpointCamera } from '../model/review';
import { VIEWPORT_FOV_DEGREES } from '../model/viewport';
import { isVec3, add3, cross3, dot3, len3, normalize3, scale3, sub3 } from '../lib/vec3';

type PlanViewName = 'top' | 'bottom' | 'front' | 'back' | 'left' | 'right' | 'iso' | 'custom';

export interface PlanCamera {
  readonly projection: 'perspective' | 'orthographic';
  readonly eye: Vec3;
  /** Unit viewing direction. */
  readonly direction: Vec3;
  /** Unit up, orthogonal to `direction`. */
  readonly up: Vec3;
  /** Perspective vertical field of view, degrees. */
  readonly fovDeg: number;
  /** Orthographic visible height in world units. */
  readonly viewHeight: number;
  readonly widthPx: number;
  readonly heightPx: number;
}

/** A half-space: `normal · p + offset >= 0` is inside. */
export interface FrustumPlane {
  readonly normal: Vec3;
  readonly offset: number;
}

const VIEW_DIRECTIONS: Readonly<Record<Exclude<PlanViewName, 'custom'>, { readonly toEye: Vec3; readonly up: Vec3 }>> = {
  top: { toEye: [0, 0, 1], up: [0, 1, 0] },
  bottom: { toEye: [0, 0, -1], up: [0, 1, 0] },
  front: { toEye: [0, -1, 0], up: [0, 0, 1] },
  back: { toEye: [0, 1, 0], up: [0, 0, 1] },
  left: { toEye: [-1, 0, 0], up: [0, 0, 1] },
  right: { toEye: [1, 0, 0], up: [0, 0, 1] },
  iso: { toEye: normalize3([1, -1.4, 1]), up: [0, 0, 1] },
};

/** Camera of a saved viewpoint on a `widthPx` x `heightPx` image. */
export function viewpointPlanCamera(camera: ViewpointCamera, widthPx: number, heightPx: number): PlanCamera {
  const base = { eye: camera.eye, direction: camera.direction, up: camera.up, widthPx, heightPx };
  return camera.projection === 'perspective'
    ? { ...base, projection: 'perspective', fovDeg: camera.fovDeg, viewHeight: 0 }
    : { ...base, projection: 'orthographic', fovDeg: 0, viewHeight: camera.viewHeight };
}

export interface FramedViewRequest {
  readonly view: PlanViewName;
  readonly direction?: Vec3 | undefined;
  readonly projection: 'perspective' | 'orthographic';
  readonly fovDeg?: number | undefined;
  readonly center: Vec3;
  readonly radius: number;
  readonly widthPx: number;
  readonly heightPx: number;
}

/**
 * A named (or custom-direction) view framing the sphere (`center`, `radius`). Perspective: the eye sits on the view axis so the sphere fits
 * `fovDeg` (default 45) with 20 % margin; orthographic: eye at 2.5 radii, visible height 2.4 radii.
 * @failure fovDeg outside (0, 180), zero custom direction or non-positive radius -> string (the reason)
 */
export function framedPlanCamera(request: FramedViewRequest): PlanCamera | string {
  const { view, projection, center, radius, widthPx, heightPx } = request;
  const fovDeg = request.fovDeg ?? VIEWPORT_FOV_DEGREES;
  if (!(fovDeg > 0 && fovDeg < 180)) return 'fovDeg must be in (0, 180)';
  if (!(radius > 0) || !Number.isFinite(radius)) return 'the scene radius must be positive and finite';
  if (request.direction !== undefined && !isVec3(request.direction)) return 'direction must be 3 finite numbers [x, y, z]';
  if (!isVec3(request.center)) return 'target must be 3 finite numbers [x, y, z]';
  let toEye: Vec3;
  let up: Vec3;
  if (view === 'custom') {
    if (request.direction === undefined || !request.direction.every(Number.isFinite) || len3(request.direction) < 1e-12)
      return 'view "custom" needs a finite, non-zero direction';
    toEye = normalize3(request.direction);
    up = Math.abs(toEye[2]) > 0.999 ? [0, 1, 0] : [0, 0, 1];
  } else ({ toEye, up } = VIEW_DIRECTIONS[view]);
  const direction = scale3(toEye, -1);
  const right = normalize3(cross3(direction, up));
  const orthogonalUp = cross3(right, direction);
  const distance = projection === 'perspective' ? (radius * 1.2) / Math.tan((fovDeg * Math.PI) / 360) + radius * 0.2 : radius * 2.5;
  return {
    projection,
    eye: add3(center, scale3(toEye, distance)),
    direction,
    up: orthogonalUp,
    fovDeg: projection === 'perspective' ? fovDeg : 0,
    viewHeight: projection === 'orthographic' ? radius * 2.4 : 0,
    widthPx,
    heightPx,
  };
}

const plane = (normal: Vec3, point: Vec3): FrustumPlane => {
  const unit = normalize3(normal);
  return { normal: unit, offset: -dot3(unit, point) };
};

/** The near plane (through the eye) and the four side planes of the view volume. */
export function frustumPlanes(camera: PlanCamera): FrustumPlane[] {
  const { eye, direction: f, up: u } = camera;
  const r = normalize3(cross3(f, u));
  const aspect = camera.widthPx / camera.heightPx;
  const near = plane(f, eye);
  if (camera.projection === 'perspective') {
    const tv = Math.tan((camera.fovDeg * Math.PI) / 360);
    const th = tv * aspect;
    return [
      near,
      plane(add3(r, scale3(f, th)), eye),
      plane(add3(scale3(r, -1), scale3(f, th)), eye),
      plane(add3(u, scale3(f, tv)), eye),
      plane(add3(scale3(u, -1), scale3(f, tv)), eye),
    ];
  }
  const halfH = camera.viewHeight / 2;
  const halfW = halfH * aspect;
  return [
    near,
    plane(r, sub3(eye, scale3(r, halfW))),
    plane(scale3(r, -1), add3(eye, scale3(r, halfW))),
    plane(u, sub3(eye, scale3(u, halfH))),
    plane(scale3(u, -1), add3(eye, scale3(u, halfH))),
  ];
}

/** Why `camera` cannot be planned (non-finite or wrongly sized vectors, zero direction, bad fov / view height / image size), or null. */
export function planCameraProblem(camera: PlanCamera): string | null {
  if (![camera.eye, camera.direction, camera.up].every(isVec3)) return 'eye, direction and up must be 3 finite numbers';
  if (len3(camera.direction) < 1e-12 || len3(camera.up) < 1e-12) return 'direction and up must be non-zero';
  if (!(camera.widthPx > 0 && camera.heightPx > 0)) return 'image size must be positive';
  if (camera.projection === 'perspective' && !(camera.fovDeg > 0 && camera.fovDeg < 180)) return 'fovDeg must be in (0, 180)';
  if (camera.projection === 'orthographic' && !(camera.viewHeight > 0 && Number.isFinite(camera.viewHeight)))
    return 'viewHeight must be > 0';
  return null;
}
