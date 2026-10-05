/**
 * @layer ui/viewport
 * Unlit line material for overlays drawn on top of the scene (depth test off), disposed with
 * its component (R9). Pass `opacity` to make it translucent.
 */

import * as THREE from 'three';
import { useDisposable } from './useDisposable';

export function useOverlayMaterial(color: string, opacity?: number): THREE.LineBasicMaterial {
  return useDisposable(
    () =>
      new THREE.LineBasicMaterial({
        color,
        depthTest: false,
        ...(opacity === undefined ? {} : { transparent: true, opacity }),
      }),
    [color, opacity],
  );
}
