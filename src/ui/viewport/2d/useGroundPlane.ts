/**
 * @layer ui/viewport/2d
 *
 * Invisible 1e8-square plane used by the 2D interaction layers to capture pointer
 * events on the drafting plane. Geometry + material are memoized and disposed on unmount (R9).
 */

import { useEffect, useMemo } from 'react';
import * as THREE from 'three';

export function useGroundPlane(): { geo: THREE.PlaneGeometry; mat: THREE.MeshBasicMaterial } {
  const geo = useMemo(() => new THREE.PlaneGeometry(1e8, 1e8), []);
  const mat = useMemo(
    () => new THREE.MeshBasicMaterial({ visible: false, side: THREE.DoubleSide }),
    [],
  );

  useEffect(() => {
    return () => {
      geo.dispose();
      mat.dispose();
    };
  }, [geo, mat]);

  return { geo, mat };
}
