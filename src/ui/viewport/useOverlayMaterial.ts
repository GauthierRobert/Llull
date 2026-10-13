// Unlit overlay line material (depth test off), optionally translucent, disposed with its component.

import * as THREE from 'three';
import { useDisposable } from './useDisposable';

export function useOverlayMaterial(color: string, opacity?: number): THREE.LineBasicMaterial {
  return useDisposable(
    () => new THREE.LineBasicMaterial({ color, depthTest: false, ...(opacity === undefined ? {} : { transparent: true, opacity }) }),
    [color, opacity],
  );
}
