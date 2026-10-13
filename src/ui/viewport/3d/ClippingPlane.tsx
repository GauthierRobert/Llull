// In-Canvas sync adapter: while enabled, one axis-aligned render-space plane (clipPlaneMath) in gl.clippingPlanes
// (±X/±Y/±Z per axis + flipped, shifted by offset); disabling or unmounting clears it.

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

  // Stable, updated in place: no material recompiles.
  const planeRef = useRef<THREE.Plane>(new THREE.Plane(new THREE.Vector3(0, 0, 1), 0));

  useEffect(() => {
    if (!enabled) return;

    const plane = planeRef.current;
    // Render space = world − renderOrigin.
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
