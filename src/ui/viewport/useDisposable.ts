/**
 * @layer ui/viewport
 * `useMemo` for a three.js resource (geometry, material, texture) that is disposed when it is
 * replaced or its component unmounts (R9). `deps` must list everything `create` reads.
 */

import { useEffect, useMemo, type DependencyList } from 'react';
import type { Vec2 } from '@core/model/types';
import { anchoredGeometry } from './lineGeometry';

export function useDisposable<T extends { dispose: () => void }>(create: () => T, deps: DependencyList): T {
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const resource = useMemo(create, deps);
  useEffect(() => () => resource.dispose(), [resource]);
  return resource;
}

/** Anchored segment geometry (see `anchoredGeometry`) rebuilt when `deps` change and disposed with it. */
export function useAnchoredGeometry(
  vertices: () => ReadonlyArray<Vec2>,
  z: number,
  deps: DependencyList,
): { geometry: ReturnType<typeof anchoredGeometry>['geometry']; anchor: [number, number, number] } {
  const anchored = useDisposable(() => {
    const { geometry, anchor } = anchoredGeometry(vertices(), z);
    return { geometry, anchor, dispose: () => geometry.dispose() };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- caller supplies the deps
  }, deps);
  return anchored;
}
