// The loaded textures of an appearance's image maps, by channel. Acquires from the shared cache on mount / change and releases on
// cleanup (textures are disposed with their last user); re-renders when one finishes loading. Channels still loading, or whose fetch
// failed, are absent, which `surfacePlan` turns into the no-map value.

import { useEffect, useState } from 'react';
import type * as THREE from 'three';
import { acquireImageTexture } from './imageTextureCache';
import type { MapChannel, MapRequest } from './surfacePlan';

export type AppearanceMaps = Readonly<Partial<Record<MapChannel, THREE.Texture>>>;

const NO_MAPS: AppearanceMaps = {};

export function useAppearanceMaps(requests: readonly MapRequest[]): AppearanceMaps {
  const [maps, setMaps] = useState<AppearanceMaps>(NO_MAPS);
  // Content identity: the request list is rebuilt every render, its content rarely changes.
  const signature = requests.map((r) => `${r.channel}|${r.colorSpace}|${r.key}`).join('\n');
  useEffect(() => {
    if (signature === '') return undefined;
    const collect = (): void => {
      const ready: Partial<Record<MapChannel, THREE.Texture>> = {};
      for (const [channel, handle] of held) {
        const texture = handle.read();
        if (texture !== null) ready[channel] = texture;
      }
      setMaps(ready);
    };
    const held = requests.map((r) => [r.channel, acquireImageTexture(r.key, r.colorSpace, collect)] as const);
    return () => {
      // Drop the references before the last release disposes the textures.
      setMaps(NO_MAPS);
      held.forEach(([, handle]) => handle.release());
    };
    // `signature` is the content identity of `requests`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);
  return signature === '' ? NO_MAPS : maps;
}
