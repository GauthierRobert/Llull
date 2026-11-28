// Pure: the `set_camera` parameters that put the viewport's eye where a camera entity is, looking along its aim (-Z, turned by Euler XYZ),
// with the orbit target `focusDistance` ahead. The viewport keeps its own field of view; position and direction match the camera.

import * as THREE from 'three';
import type { CameraFields } from '@core/model/sceneKinds';
import type { Vec3 } from '@core/model/types';

export interface LookThroughParams {
  readonly target: Vec3;
  readonly azimuth: number;
  readonly polar: number;
  readonly distance: number;
}

export function lookThroughCamera(
  camera: { readonly position: Vec3; readonly rotation: Vec3 } & Pick<CameraFields, 'focusDistance'>,
): LookThroughParams {
  const forward = new THREE.Vector3(0, 0, -1).applyEuler(
    new THREE.Euler(camera.rotation[0], camera.rotation[1], camera.rotation[2], 'XYZ'),
  );
  const distance = camera.focusDistance;
  const target: Vec3 = [
    camera.position[0] + forward.x * distance,
    camera.position[1] + forward.y * distance,
    camera.position[2] + forward.z * distance,
  ];
  // The eye sits at target + distance * (sin p sin a, sin p cos a, cos p): the unit vector from target to eye is -forward.
  return { target, azimuth: Math.atan2(-forward.x, -forward.y), polar: Math.acos(Math.min(1, Math.max(-1, -forward.z))), distance };
}
