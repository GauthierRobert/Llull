/**
 * @layer ui/viewport/2d
 *
 * Mounts a memoized three.js Line/LineSegments at the entity's position and disposes its
 * geometry + material when the object changes or unmounts (R9). Shared by every 2D curve
 * renderer; each renderer only builds its object.
 */

import { useEffect } from 'react';
import type * as THREE from 'three';
import type { Vec3 } from '@core/model/types';

interface PlacedLineObjectProps {
  object: THREE.Line | THREE.LineSegments | null;
  position: Vec3;
}

export function PlacedLineObject({
  object,
  position,
}: PlacedLineObjectProps): React.ReactElement | null {
  useEffect(() => {
    return () => {
      object?.geometry.dispose();
      (object?.material as THREE.Material | undefined)?.dispose();
    };
  }, [object]);

  if (!object) return null;
  object.position.set(position[0], position[1], position[2]);
  return <primitive object={object} />;
}
