/**
 * Viewpoint camera maths (plant 09 VIS §5.3): validation / orthonormalisation of a BCF-style camera, the document orbit camera as a
 * viewpoint, and camera interpolation between walkthrough keys (eye lerp, direction / up slerp, fov or view height lerp). Pure.
 * @invariant every returned camera has unit, orthogonal direction and up (± 1e-9)
 */

import type { CameraState, Vec3 } from '../model/types';
import type { ViewpointCamera } from '../model/review';
import { VIEWPORT_FOV_DEGREES } from '../model/viewport';
import { add3, cross3, dot3, len3, lerp3, normalize3, scale3, sub3 } from '../lib/vec3';
import { clamp } from '../lib/clamp';

const finite = (v: Vec3): boolean => v.every(Number.isFinite);

/** `up` made orthogonal to the unit `direction` and normalised, or null when they are (nearly) parallel. */
function orthogonalUp(direction: Vec3, up: Vec3): Vec3 | null {
  const projected = sub3(up, scale3(direction, dot3(up, direction)));
  return len3(projected) < 1e-9 * Math.max(1, len3(up)) ? null : normalize3(projected);
}

/**
 * The camera with unit, orthogonal direction / up, or the reason it is invalid.
 * @failure non-finite values, zero direction / up, up parallel to direction, fovDeg ∉ (0, 180), viewHeight ≤ 0 -> string
 */
export function normalizeViewpointCamera(camera: ViewpointCamera): ViewpointCamera | string {
  const { eye, direction, up } = camera;
  if (!finite(eye) || !finite(direction) || !finite(up)) return 'eye, direction and up must be finite';
  if (len3(direction) < 1e-12) return 'direction must be non-zero';
  const unitDirection = normalize3(direction);
  const unitUp = orthogonalUp(unitDirection, up);
  if (unitUp === null) return 'up must be non-zero and not parallel to direction';
  if (camera.projection === 'perspective') {
    if (!(camera.fovDeg > 0 && camera.fovDeg < 180)) return 'fovDeg must be in (0, 180)';
    return { projection: 'perspective', eye, direction: unitDirection, up: unitUp, fovDeg: camera.fovDeg };
  }
  if (!(camera.viewHeight > 0) || !Number.isFinite(camera.viewHeight)) return 'viewHeight must be > 0';
  return { projection: 'orthographic', eye, direction: unitDirection, up: unitUp, viewHeight: camera.viewHeight };
}

/** The document orbit camera (`set_camera` convention: eye = target + distance·(sin p sin a, sin p cos a, cos p)) as a viewpoint. */
export function documentCameraViewpoint(camera: CameraState): ViewpointCamera {
  const { target, azimuth, polar, distance } = camera;
  const offset: Vec3 = [Math.sin(polar) * Math.sin(azimuth), Math.sin(polar) * Math.cos(azimuth), Math.cos(polar)];
  const eye = add3(target, scale3(offset, distance));
  const direction = normalize3(scale3(offset, -1));
  const up = orthogonalUp(direction, [0, 0, 1]) ?? orthogonalUp(direction, [0, 1, 0]) ?? [0, 1, 0];
  return { projection: 'perspective', eye, direction, up, fovDeg: VIEWPORT_FOV_DEGREES };
}

/** Spherical interpolation of unit vectors (antipodal pairs turn about an arbitrary perpendicular axis). */
function slerp(a: Vec3, b: Vec3, t: number): Vec3 {
  const cos = Math.max(-1, Math.min(1, dot3(a, b)));
  const angle = Math.acos(cos);
  if (angle < 1e-9) return a;
  const sin = Math.sin(angle);
  if (sin < 1e-6) {
    const helper: Vec3 = Math.abs(a[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    const perpendicular = normalize3(cross3(a, helper));
    return normalize3(add3(scale3(a, Math.cos(angle * t)), scale3(perpendicular, Math.sin(angle * t))));
  }
  return normalize3(add3(scale3(a, Math.sin((1 - t) * angle) / sin), scale3(b, Math.sin(t * angle) / sin)));
}

/**
 * Camera at `t` ∈ [0, 1] between two normalised cameras of the same projection.
 * @invariant t = 0 gives `a`, t = 1 gives `b` (up to the orthonormalisation of up)
 */
export function interpolateViewpointCamera(a: ViewpointCamera, b: ViewpointCamera, t: number): ViewpointCamera {
  const eye = lerp3(a.eye, b.eye, t);
  const direction = slerp(a.direction, b.direction, t);
  const up = orthogonalUp(direction, slerp(a.up, b.up, t)) ?? orthogonalUp(direction, a.up) ?? a.up;
  if (a.projection === 'perspective' && b.projection === 'perspective')
    return { projection: 'perspective', eye, direction, up, fovDeg: a.fovDeg + (b.fovDeg - a.fovDeg) * t };
  const heightOf = (camera: ViewpointCamera): number => (camera.projection === 'orthographic' ? camera.viewHeight : 1);
  return { projection: 'orthographic', eye, direction, up, viewHeight: heightOf(a) + (heightOf(b) - heightOf(a)) * t };
}

/**
 * The document orbit camera (`set_camera` convention) that looks the way `camera` does (inverse of `documentCameraViewpoint`): target = eye +
 * direction · r, where r is the distance along the view axis to `sceneCentre` when that lies ahead of the eye, else `fallbackDistance`.
 * @invariant polar ∈ [0.01, π − 0.01] (the eye never reaches a pole, like set_camera); distance > 0
 */
export function viewpointDocumentCamera(camera: ViewpointCamera, sceneCentre: Vec3 | null, fallbackDistance: number): CameraState {
  const ahead = sceneCentre === null ? 0 : dot3(sub3(sceneCentre, camera.eye), camera.direction);
  const distance = ahead > 1e-6 ? ahead : Math.max(fallbackDistance, 1e-6);
  const offset = scale3(camera.direction, -1);
  return {
    target: add3(camera.eye, scale3(camera.direction, distance)),
    azimuth: Math.atan2(offset[0] + 0, offset[1]),
    polar: clamp(Math.acos(clamp(offset[2], -1, 1)), 0.01, Math.PI - 0.01),
    distance,
  };
}
