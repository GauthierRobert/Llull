// The r3f camera as a plan camera in document coordinates, and its widened copy used while the camera moves. Pure apart from reading
// three.js camera objects.

import * as THREE from 'three';
import type { Vec3 } from '@core/model/types';
import { type PlanCamera, planCameraProblem } from '@core/geometry/renderPlanCamera';

/** Frustum margin while the camera moves: the plan covers this many times the view on each axis. */
const MOTION_MARGIN = 1.5;

/**
 * Plan camera of `camera`; `renderOrigin` is the floating-origin offset (document = scene + origin). Null while it is unplannable
 * (zero-size canvas, degenerate camera).
 */
export function planCameraOf(camera: THREE.Camera, renderOrigin: Vec3, widthPx: number, heightPx: number): PlanCamera | null {
  const direction = camera.getWorldDirection(new THREE.Vector3());
  const up = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
  const base = {
    eye: [camera.position.x + renderOrigin[0], camera.position.y + renderOrigin[1], camera.position.z + renderOrigin[2]] as Vec3,
    direction: [direction.x, direction.y, direction.z] as Vec3,
    up: [up.x, up.y, up.z] as Vec3,
    widthPx,
    heightPx,
  };
  const planCamera: PlanCamera =
    camera instanceof THREE.OrthographicCamera
      ? { ...base, projection: 'orthographic', fovDeg: 0, viewHeight: (camera.top - camera.bottom) / camera.zoom }
      : { ...base, projection: 'perspective', fovDeg: (camera as THREE.PerspectiveCamera).fov, viewHeight: 0 };
  return planCameraProblem(planCamera) === null ? planCamera : null;
}

/**
 * The same view with the frustum widened by `margin` on both axes and the pixel density kept (the image grows with the view), so LODs
 * stay put and only the culling region grows.
 */
export function motionCamera(camera: PlanCamera, margin = MOTION_MARGIN): PlanCamera {
  const scaled = { widthPx: camera.widthPx * margin, heightPx: camera.heightPx * margin };
  return camera.projection === 'orthographic'
    ? { ...camera, ...scaled, viewHeight: camera.viewHeight * margin }
    : { ...camera, ...scaled, fovDeg: (2 * Math.atan(margin * Math.tan((camera.fovDeg * Math.PI) / 360)) * 180) / Math.PI };
}
