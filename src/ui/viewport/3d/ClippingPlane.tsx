/**
 * @layer ui/viewport/3d
 *
 * Manages the three.js global clipping plane for the section-cut feature. Mount INSIDE the r3f
 * <Canvas> so that `useThree` resolves.
 *
 * While the section plane is enabled it sets `gl.localClippingEnabled` and applies one
 * axis-aligned THREE.Plane (in render space, see clipPlaneMath.ts) to `gl.clippingPlanes`: the normal is ±X / ±Y / ±Z per `axis` +
 * `flipped`, and `offset` shifts the plane along it. Disabling (or unmounting) clears both.
 *
 * No React state is set here (R6: effects are for external synchronisation): the viewport store
 * drives the clip state and this component is a sync adapter to the renderer.
 */

import { useEffect, useRef } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { useStore, useViewportStore } from '@ui/store';
import { renderClipPlane } from './clipPlaneMath';

export function ClippingPlane(): null {
  const gl = useThree((s) => s.gl);
  const invalidate = useThree((s) => s.invalidate);
  const renderOrigin = useStore((s) => s.renderOrigin);
  const { enabled, axis, offset, flipped } = useViewportStore((s) => s.clipPlane);

  // One stable Plane, updated in place, to avoid material re-compilation (R9).
  const planeRef = useRef<THREE.Plane>(new THREE.Plane(new THREE.Vector3(0, 0, 1), 0));

  useEffect(() => {
    if (!enabled) return;

    const plane = planeRef.current;
    // The scene lives in render space (world − renderOrigin): shift the plane with it.
    const clip = renderClipPlane(axis, flipped, offset, renderOrigin);
    plane.normal.set(...clip.normal);
    plane.constant = clip.constant;

    gl.localClippingEnabled = true;
    gl.clippingPlanes = [plane];
    invalidate();

    return () => {
      gl.clippingPlanes = [];
      gl.localClippingEnabled = false;
    };
  }, [gl, invalidate, enabled, axis, offset, flipped, renderOrigin]);

  return null;
}
