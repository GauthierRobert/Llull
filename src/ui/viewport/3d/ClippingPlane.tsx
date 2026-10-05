/**
 * @layer ui/viewport/3d
 *
 * Manages the three.js global clipping plane for the section-cut feature. Mount INSIDE the r3f
 * <Canvas> so that `useThree` resolves.
 *
 * While the section plane is enabled it sets `gl.localClippingEnabled` and applies one
 * axis-aligned THREE.Plane to `gl.clippingPlanes`: the normal is ±X / ±Y / ±Z per `axis` +
 * `flipped`, and `offset` shifts the plane along it. Disabling (or unmounting) clears both.
 *
 * No React state is set here (R6: effects are for external synchronisation): the viewport store
 * drives the clip state and this component is a sync adapter to the renderer.
 */

import { useEffect, useRef } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { useViewportStore } from '@ui/store';
import type { ClipAxis } from '@ui/store';

const AXIS_INDEX: Record<ClipAxis, number> = { x: 0, y: 1, z: 2 };

export function ClippingPlane(): null {
  const { gl } = useThree();
  const { enabled, axis, offset, flipped } = useViewportStore((s) => s.clipPlane);

  // One stable Plane, updated in place, to avoid material re-compilation (R9).
  const planeRef = useRef<THREE.Plane>(new THREE.Plane(new THREE.Vector3(0, 0, 1), 0));

  useEffect(() => {
    if (!enabled) return;

    const plane = planeRef.current;
    plane.normal.set(0, 0, 0).setComponent(AXIS_INDEX[axis], flipped ? -1 : 1);
    // plane equation: normal · X + constant = 0 → constant = -offset
    plane.constant = -offset;

    gl.localClippingEnabled = true;
    gl.clippingPlanes = [plane];

    return () => {
      gl.clippingPlanes = [];
      gl.localClippingEnabled = false;
    };
  }, [gl, enabled, axis, offset, flipped]);

  return null;
}
