/**
 * @layer ui/viewport/3d
 * Camera synchronisation inside the Canvas: document.camera -> live camera/controls, and
 * adaptive near/far. Presentation only.
 */

import { useEffect, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import type * as THREE from 'three';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import { useStore } from '@ui/store';

/**
 * Convert spherical CameraState → a cartesian THREE.Vector3 eye position.
 *
 * +Z-up right-handed convention:
 *   polar=0   → camera directly above the target along +Z
 *   polar=π/2 → camera in the XY plane (at target elevation)
 *   azimuth   → angle in the XY plane from +Y axis toward +X
 */
export function sphericalToCartesian(
  target: [number, number, number],
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
 * Reacts to `document.camera` changes written by commands (`set_camera`, `fit_view`)
 * and imperatively updates the PerspectiveCamera + OrbitControls to match.
 *
 * Pattern (R6): useEffect syncs an external object (three.js camera/controls) to
 * React state. Does NOT push drag-orbit updates back to the store — orbit/zoom
 * are presentation-only (architecture L4; PRIME DIRECTIVE).
 *
 * Feedback-loop guard: the effect compares the incoming CameraState value against
 * what the live camera currently shows (target + azimuth/polar/distance computed
 * from the camera position). Only applies when the selector produces a new object
 * reference (Zustand shallow equality keeps this stable through re-renders caused
 * by unrelated store slices).
 *
 * Must be mounted inside the Canvas so useThree resolves.
 */
export function CameraReactor(): null {
  const { camera, controls, invalidate } = useThree();
  // Narrow selector: only subscribe to the camera slice (R3).
  const docCamera = useStore((s) => s.document.camera);

  useEffect(() => {
    const orbit = controls as OrbitControlsImpl | null;
    if (!orbit) return;

    // The camera lives in render space (world − renderOrigin), like the entity group.
    const [ox, oy, oz] = useStore.getState().renderOrigin;
    const newPos = sphericalToCartesian(
      docCamera.target as [number, number, number],
      docCamera.azimuth,
      docCamera.polar,
      docCamera.distance,
    );

    camera.position.set(newPos[0] - ox, newPos[1] - oy, newPos[2] - oz);
    orbit.target.set(docCamera.target[0] - ox, docCamera.target[1] - oy, docCamera.target[2] - oz);

    // Sync OrbitControls internal spherical state to new position/target.
    orbit.update();
    // Queue a render frame (demand frameloop).
    invalidate();
  }, [docCamera, camera, controls, invalidate]);

  return null;
}

/**
 * Keeps depth precision usable from millimetre parts to building-scale models (1e4–1e5 units in
 * mm): near/far track the camera→target distance at a fixed 1:4e6 ratio. Updates the projection
 * only when the distance changed by more than 10 %.
 */
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
