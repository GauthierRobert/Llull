// `environment.source === 'hdr'`: the equirectangular .hdr of the image asset store as the scene's image-based light AND background, with
// rotation about +Z and intensity. Until it has loaded (or when it cannot: no backend, missing file) it renders nothing, and the built-in
// environment stays (SceneLighting reads `useHdrEnvironment` to step aside only once this one is ready).

import { useEffect, useState } from 'react';
import { useThree } from '@react-three/fiber';
import type * as THREE from 'three';
import { useStore } from '@ui/store';
import { acquireImageTexture } from './imageTextureCache';
import { hdrOrientation } from './environmentPlan';

export interface HdrEnvironmentState {
  readonly texture: THREE.Texture;
  readonly rotation: number;
  readonly intensity: number;
}

/** The loaded HDR environment, or null (not an hdr environment, missing record, still loading, failed). */
export function useHdrEnvironment(): HdrEnvironmentState | null {
  const environment = useStore((s) => s.document.appearance?.environment);
  const record = useStore((s) => (environment?.source === 'hdr' ? s.document.appearance?.textures[environment.texture] : undefined));
  const key = record?.format === 'hdr' ? record.key : undefined;
  const [texture, setTexture] = useState<THREE.Texture | null>(null);
  useEffect(() => {
    if (key === undefined) return undefined;
    const handle = acquireImageTexture(key, 'hdr', () => setTexture(handle.read()));
    return () => {
      setTexture(null);
      handle.release();
    };
  }, [key]);
  if (environment?.source !== 'hdr' || texture === null) return null;
  return { texture, rotation: environment.rotation, intensity: environment.intensity };
}

/**
 * In-Canvas: applies the loaded HDR to the scene (light + reflections; also the backdrop when `background`: the post-processing chain
 * composites a plain colour only, so with it on the backdrop stays the palette colour, RV-M4) and restores the previous environment / background on change or unmount. */
export function HdrEnvironment({ background }: { background: boolean }): null {
  const hdr = useHdrEnvironment();
  const scene = useThree((s) => s.scene);
  const invalidate = useThree((s) => s.invalidate);
  useEffect(() => {
    if (hdr === null) return undefined;
    const previous = { environment: scene.environment, background: scene.background };
    const [x, y, z] = hdrOrientation(hdr.rotation);
    scene.environment = hdr.texture;
    if (background) scene.background = hdr.texture;
    scene.environmentIntensity = hdr.intensity;
    scene.backgroundIntensity = hdr.intensity;
    scene.environmentRotation.set(x, y, z, 'ZXY');
    scene.backgroundRotation.set(x, y, z, 'ZXY');
    invalidate();
    return () => {
      // Only what is still ours: a background colour mounted in the same commit must not be overwritten.
      if (scene.environment === hdr.texture) scene.environment = previous.environment;
      if (scene.background === hdr.texture) scene.background = previous.background;
      scene.environmentIntensity = 1;
      scene.backgroundIntensity = 1;
      scene.environmentRotation.set(0, 0, 0);
      scene.backgroundRotation.set(0, 0, 0);
      invalidate();
    };
  }, [hdr, background, scene, invalidate]);
  return null;
}
