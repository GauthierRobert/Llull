/**
 * @layer ui/viewport
 * `useMemo` for a three.js resource (geometry, material, texture) that is disposed when it is
 * replaced or its component unmounts (R9). `deps` must list everything `create` reads.
 */

import { useEffect, useMemo, type DependencyList } from 'react';

export function useDisposable<T extends { dispose: () => void }>(
  create: () => T,
  deps: DependencyList,
): T {
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const resource = useMemo(create, deps);
  useEffect(() => () => resource.dispose(), [resource]);
  return resource;
}
