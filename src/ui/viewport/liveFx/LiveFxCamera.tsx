// In-Canvas: when a remote edit lands outside the view, glide the camera (same direction, eased) until it is framed.
// Presentation only (never set_camera: online the document camera is shared); any orbit gesture cancels the glide.

import { useEffect, useRef, useState } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import type { Bounds } from '@core/geometry/bounds';
import { useStore } from '@ui/store';
import { useLiveFxStore } from '@ui/store/liveFxStore';
import { easeInOutCubic, progressAt } from './liveFxMath';

const GLIDE_MS = 1100;
const FIT_MARGIN = 1.25;

interface Glide {
  readonly startMs: number;
  readonly fromTarget: THREE.Vector3;
  readonly fromPosition: THREE.Vector3;
  readonly toTarget: THREE.Vector3;
  readonly toPosition: THREE.Vector3;
}

function boundsCorners(b: Bounds, origin: readonly [number, number, number]): THREE.Vector3[] {
  const corners: THREE.Vector3[] = [];
  for (const x of [b.min[0], b.max[0]])
    for (const y of [b.min[1], b.max[1]])
      for (const z of [b.min[2], b.max[2]]) corners.push(new THREE.Vector3(x - origin[0], y - origin[1], z - origin[2]));
  return corners;
}

/** True when every corner projects inside the viewport (in front of the camera). */
function fullyVisible(camera: THREE.Camera, corners: readonly THREE.Vector3[]): boolean {
  return corners.every((corner) => {
    const ndc = corner.clone().project(camera);
    return ndc.z < 1 && Math.abs(ndc.x) <= 0.95 && Math.abs(ndc.y) <= 0.95;
  });
}

export function LiveFxCamera(): null {
  const camera = useThree((s) => s.camera);
  const controls = useThree((s) => s.controls);
  const invalidate = useThree((s) => s.invalidate);
  const glideRef = useRef<Glide | null>(null);
  const focus = useLiveFxStore((s) => s.focus);
  // A focus older than this view (e.g. made while the 2D view was shown) is history, not news.
  const [mountNonce] = useState(() => useLiveFxStore.getState().focus?.nonce ?? 0);

  useEffect(() => {
    const orbit = controls as OrbitControlsImpl | null;
    if (orbit === null) return undefined;
    const cancel = (): void => {
      glideRef.current = null;
    };
    orbit.addEventListener('start', cancel);
    return () => orbit.removeEventListener('start', cancel);
  }, [controls]);

  useEffect(() => {
    const orbit = controls as OrbitControlsImpl | null;
    if (focus === null || focus.nonce <= mountNonce || orbit === null || !(camera instanceof THREE.PerspectiveCamera)) return;
    const origin = useStore.getState().renderOrigin;
    const corners = boundsCorners(focus.bounds, origin);
    if (fullyVisible(camera, corners)) return;
    const box = new THREE.Box3().setFromPoints(corners);
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const halfFov = THREE.MathUtils.degToRad(camera.fov / 2);
    const fitDistance = (Math.max(sphere.radius, 1e-3) * FIT_MARGIN) / Math.sin(Math.min(halfFov, halfFov * camera.aspect));
    const direction = camera.position.clone().sub(orbit.target).normalize();
    const distance = Math.max(camera.position.distanceTo(orbit.target), fitDistance);
    glideRef.current = {
      startMs: performance.now(),
      fromTarget: orbit.target.clone(),
      fromPosition: camera.position.clone(),
      toTarget: sphere.center.clone(),
      toPosition: sphere.center.clone().addScaledVector(direction, distance),
    };
    invalidate();
  }, [focus, mountNonce, camera, controls, invalidate]);

  useFrame(() => {
    const glide = glideRef.current;
    const orbit = controls as OrbitControlsImpl | null;
    if (glide === null || orbit === null) return;
    const t = progressAt(performance.now(), glide.startMs, GLIDE_MS);
    const k = easeInOutCubic(t);
    orbit.target.lerpVectors(glide.fromTarget, glide.toTarget, k);
    camera.position.lerpVectors(glide.fromPosition, glide.toPosition, k);
    camera.lookAt(orbit.target);
    orbit.update();
    if (t >= 1) glideRef.current = null;
    invalidate();
  });

  return null;
}
