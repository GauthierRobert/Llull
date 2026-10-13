// The single camera driver: under frameloop="demand" a programmatic move needs controls.update() AND invalidate().
// CameraBridge (in-Canvas) registers it for DOM overlays (view presets, named views); never holds the document.

import { useEffect } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import { type NamedViewCamera, useStore } from '@ui/store';
import { toRenderPosition } from './floatingOrigin';

type Vec3 = readonly [number, number, number];

/** WORLD-space position/target (the camera lives in render space). */
export function driveCamera(camera: THREE.Camera, orbit: OrbitControlsImpl, invalidate: () => void, position: Vec3, target: Vec3): void {
  const { renderOrigin } = useStore.getState();
  const renderTarget = new THREE.Vector3(...toRenderPosition(target, renderOrigin));
  camera.up.set(0, 0, 1);
  camera.position.set(...toRenderPosition(position, renderOrigin));
  camera.lookAt(renderTarget);
  orbit.target.copy(renderTarget);
  orbit.update();
  invalidate();
}

const bridge: {
  placeCamera: ((position: Vec3, target: Vec3) => void) | null;
  getCameraSnapshot: (() => NamedViewCamera | null) | null;
  getAspect: (() => number) | null;
} = { placeCamera: null, getCameraSnapshot: null, getAspect: null };

export function placeCamera(position: Vec3, target: Vec3): void {
  bridge.placeCamera?.(position, target);
}

/** World space; null before the Canvas mounts. */
export function getCameraSnapshot(): NamedViewCamera | null {
  return bridge.getCameraSnapshot?.() ?? null;
}

/** 1 before mount or with zero height. */
export function getAspect(): number {
  return bridge.getAspect?.() ?? 1;
}

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
    // A stale closure over a disposed camera must not fire after teardown.
    return () => {
      bridge.placeCamera = null;
      bridge.getCameraSnapshot = null;
      bridge.getAspect = null;
    };
  }, [camera, controls, invalidate, get]);

  return null;
}
