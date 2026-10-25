// Param gathering for save_viewpoint: the live orbit camera (world position + target) as a perspective viewpoint camera.

import type { CameraSnapshot } from './cameraBridge';

export interface ViewpointCameraParams {
  projection: 'perspective';
  eye: [number, number, number];
  direction: [number, number, number];
  up: [number, number, number];
}

/** Eye at the camera, looking at the orbit target; null when they coincide. Up is +Z (the viewport's), or +Y when looking straight along Z. */
export function viewpointCameraParams({ position, target }: CameraSnapshot): ViewpointCameraParams | null {
  const direction: [number, number, number] = [target[0] - position[0], target[1] - position[1], target[2] - position[2]];
  const length = Math.hypot(...direction);
  if (!(length > 0) || !Number.isFinite(length)) return null;
  const vertical = Math.hypot(direction[0], direction[1]) < 1e-6 * length;
  return { projection: 'perspective', eye: [...position], direction, up: vertical ? [0, 1, 0] : [0, 0, 1] };
}
