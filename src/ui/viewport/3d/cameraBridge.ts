/**
 * @layer ui/viewport/3d
 *
 * The single camera driver. Under frameloop="demand" every programmatic camera move must call
 * BOTH `controls.update()` and `invalidate()`; `driveCamera` does that once. `CameraBridge` (mounted
 * INSIDE the Canvas) registers it so DOM overlays (view presets, named views) outside the Canvas can
 * move/read the camera. Holds only imperative callbacks, never the document.
 */

import { useEffect } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import { type NamedViewCamera, useStore } from '@ui/store';
import { toRenderPosition } from './floatingOrigin';

type Vec3 = readonly [number, number, number];

/** Place the camera at `position` looking at `target` (both WORLD space; the camera lives in render space). */
export function driveCamera(
  camera: THREE.Camera,
  orbit: OrbitControlsImpl,
  invalidate: () => void,
  position: Vec3,
  target: Vec3,
): void {
  const { renderOrigin } = useStore.getState();
  const renderTarget = new THREE.Vector3(...toRenderPosition(target, renderOrigin));
  camera.up.set(0, 0, 1);
  camera.position.set(...toRenderPosition(position, renderOrigin));
  camera.lookAt(renderTarget);
  orbit.target.copy(renderTarget);
  // Sync OrbitControls' internal spherical state, then queue a frame (demand frameloop).
  orbit.update();
  invalidate();
}

const bridge: {
  placeCamera: ((position: Vec3, target: Vec3) => void) | null;
  getCameraSnapshot: (() => NamedViewCamera | null) | null;
  getAspect: (() => number) | null;
} = { placeCamera: null, getCameraSnapshot: null, getAspect: null };

/** Move the live camera (no-op until the Canvas has mounted). */
export function placeCamera(position: Vec3, target: Vec3): void {
  bridge.placeCamera?.(position, target);
}

/** Capture the live camera in world space; null before the Canvas has mounted. */
export function getCameraSnapshot(): NamedViewCamera | null {
  return bridge.getCameraSnapshot?.() ?? null;
}

/** Viewport width/height; 1 before the Canvas has mounted or when it has no height. */
export function getAspect(): number {
  return bridge.getAspect?.() ?? 1;
}

/** Mounted INSIDE the r3f Canvas; registers the camera callbacks for the DOM overlays. */
export function CameraBridge(): null {
  const { camera, controls, invalidate, get } = useThree();

  useEffect(() => {
    const orbit = controls as OrbitControlsImpl | null;
    bridge.placeCamera = (position, target) => {
      if (orbit) driveCamera(camera, orbit, invalidate, position, target);
    };
    bridge.getCameraSnapshot = () => {
      if (!orbit) return null;
      const [ox, oy, oz] = useStore.getState().renderOrigin;
      return {
        position: [camera.position.x + ox, camera.position.y + oy, camera.position.z + oz],
        target: [orbit.target.x + ox, orbit.target.y + oy, orbit.target.z + oz],
      };
    };
    bridge.getAspect = () => {
      const { width, height } = get().size;
      return height > 0 ? width / height : 1;
    };
    // Unregister so a stale closure over a disposed camera cannot fire after teardown.
    return () => {
      bridge.placeCamera = null;
      bridge.getCameraSnapshot = null;
      bridge.getAspect = null;
    };
  }, [camera, controls, invalidate, get]);

  return null;
}
