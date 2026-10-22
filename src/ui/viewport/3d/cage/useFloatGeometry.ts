// A BufferGeometry over a flat position array, rebuilt when the array changes and disposed with it (R9).

import * as THREE from 'three';
import { useDisposable } from '../../useDisposable';

export function useFloatGeometry(positions: Float32Array): THREE.BufferGeometry {
  return useDisposable(() => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    return geometry;
  }, [positions]);
}
