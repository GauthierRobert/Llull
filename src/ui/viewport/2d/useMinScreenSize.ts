// Scales an object per frame so text of `worldHeight` never appears below `minPixels` when zoomed out.

import type { RefObject } from 'react';
import { useFrame } from '@react-three/fiber';
import type * as THREE from 'three';

const MIN_TEXT_PIXELS = 11;

/** Scale factor (>= 1) that lifts `worldHeight` to `minPixels` at orthographic `zoom`. */
export function minScreenScale(worldHeight: number, zoom: number, minPixels: number): number {
  if (worldHeight <= 0 || zoom <= 0) return 1;
  return Math.max(1, minPixels / (worldHeight * zoom));
}

export function useMinScreenSize(target: RefObject<THREE.Object3D | null>, worldHeight: number, minPixels: number = MIN_TEXT_PIXELS): void {
  useFrame(({ camera }) => {
    const object = target.current;
    if (!object) return;
    const zoom = (camera as THREE.OrthographicCamera).zoom;
    const scale = minScreenScale(worldHeight, typeof zoom === 'number' ? zoom : 1, minPixels);
    if (object.scale.x !== scale) object.scale.setScalar(scale);
  });
}
