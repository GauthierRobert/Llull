/**
 * @layer ui/viewport/3d
 *
 * Manages the three.js global clipping plane for the section-cut feature.
 *
 * Must be mounted INSIDE the r3f <Canvas> so that `useThree` resolves.
 *
 * When the clip plane is enabled:
 *   - Sets `gl.localClippingEnabled = true` on the renderer.
 *   - Applies one axis-aligned THREE.Plane to `gl.clippingPlanes`.
 *   - The plane normal is one of ±X, ±Y, ±Z depending on `axis` + `flipped`.
 *   - `offset` shifts the plane along the normal direction.
 *
 * When disabled:
 *   - Clears `gl.clippingPlanes` and restores `localClippingEnabled = false`.
 *
 * No React state is set here (R6: effects are for external synchronisation).
 * The viewport store drives the clip state; this component is a pure sync
 * adapter between the store and the three.js renderer.
 */

import { useEffect, useRef } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { useViewportStore } from '@ui/store';
import type { ClipAxis } from '@ui/store';

/** Map axis string + flip flag → unit normal vector. */
function buildNormal(axis: ClipAxis, flipped: boolean): THREE.Vector3 {
  const sign = flipped ? -1 : 1;
  switch (axis) {
    case 'x': return new THREE.Vector3(sign, 0, 0);
    case 'z': return new THREE.Vector3(0, 0, sign);
    case 'y':
    default:  return new THREE.Vector3(0, sign, 0);
  }
}

export function ClippingPlane(): null {
  const { gl } = useThree();

  const enabled = useViewportStore((s) => s.clipPlane.enabled);
  const axis    = useViewportStore((s) => s.clipPlane.axis);
  const offset  = useViewportStore((s) => s.clipPlane.offset);
  const flipped = useViewportStore((s) => s.clipPlane.flipped);

  // Keep a stable Plane instance — update it imperatively instead of recreating
  // each render to avoid unnecessary material re-compilation (r3f R9).
  const planeRef = useRef<THREE.Plane>(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0));

  useEffect(() => {
    if (!enabled) {
      gl.clippingPlanes = [];
      gl.localClippingEnabled = false;
      return;
    }

    // Update the plane normal and constant in place.
    const normal = buildNormal(axis, flipped);
    planeRef.current.normal.copy(normal);
    // THREE.Plane constant is the negative signed distance from origin along normal:
    // plane equation: normal · X + constant = 0 → constant = -offset
    planeRef.current.constant = -offset;

    gl.localClippingEnabled = true;
    gl.clippingPlanes = [planeRef.current];

    return () => {
      // Cleanup on unmount or when disabled transitions.
      gl.clippingPlanes = [];
      gl.localClippingEnabled = false;
    };
  }, [gl, enabled, axis, offset, flipped]);

  return null;
}
