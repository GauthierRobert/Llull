// In-Canvas camera sync: document.camera → live camera/controls, plus adaptive near/far.

import { useEffect, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import type * as THREE from 'three';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import { useStore } from '@ui/store';
import { driveCamera } from './cameraBridge';

/** Spherical → eye, +Z up: polar 0 = above the target, π/2 = in its XY plane; azimuth from +Y toward +X. */
export function sphericalToCartesian(
  target: readonly [number, number, number],
  azimuth: number,
  polar: number,
  distance: number,
): [number, number, number] {
  const sinPolar = Math.sin(polar);
  return [
    target[0] + distance * sinPolar * Math.sin(azimuth),
    target[1] + distance * sinPolar * Math.cos(azimuth),
    target[2] + distance * Math.cos(polar),
  ];
}

/**
 * Applies `document.camera` (set_camera, fit_view) to the camera + OrbitControls. Orbit/zoom are never pushed back
 * (presentation only); the effect runs only on a new camera object, so unrelated store updates cannot loop.
 */
export function CameraReactor(): null {
  const { camera, controls, invalidate } = useThree();
  const docCamera = useStore((s) => s.document.camera);

  useEffect(() => {
    const orbit = controls as OrbitControlsImpl | null;
    if (!orbit) return;

    const eye = sphericalToCartesian(docCamera.target, docCamera.azimuth, docCamera.polar, docCamera.distance);
    driveCamera(camera, orbit, invalidate, eye, docCamera.target);
  }, [docCamera, camera, controls, invalidate]);

  return null;
}

/** Depth precision from mm parts to building scale: near/far track the target distance (1:4e6), re-projected on a > 10 % change. */
export function AdaptiveClipping(): null {
  const { camera, controls } = useThree();
  const lastDistance = useRef(0);
  useFrame(() => {
    const target = (controls as OrbitControlsImpl | null)?.target;
    if (!target) return;
    const distance = camera.position.distanceTo(target);
    if (Math.abs(distance - lastDistance.current) <= lastDistance.current * 0.1) return;
    lastDistance.current = distance;
    const perspective = camera as THREE.PerspectiveCamera;
    perspective.near = Math.max(distance / 2000, 1e-3);
    perspective.far = Math.max(distance * 2000, 1e3);
    perspective.updateProjectionMatrix();
  });
  return null;
}
