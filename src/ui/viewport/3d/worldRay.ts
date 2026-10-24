// World-space pointer rays. The camera lives in render space (document - renderOrigin, the floating origin), so the ray origin is shifted
// back by the origin in float64; the direction is unchanged. One reusable raycaster per factory (no per-event allocation).

import * as THREE from 'three';
import type { Vec3 } from '@core/model/types';
import { useStore } from '@ui/store';

export interface WorldRay {
  readonly origin: Vec3;
  /** Unit length. */
  readonly direction: Vec3;
}

export function createWorldRay(gl: THREE.WebGLRenderer, camera: THREE.Camera): (clientX: number, clientY: number) => WorldRay {
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  return (clientX, clientY) => {
    const rect = gl.domElement.getBoundingClientRect();
    ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    const origin = useStore.getState().renderOrigin;
    const { origin: o, direction: d } = raycaster.ray;
    return { origin: [o.x + origin[0], o.y + origin[1], o.z + origin[2]], direction: [d.x, d.y, d.z] };
  };
}
