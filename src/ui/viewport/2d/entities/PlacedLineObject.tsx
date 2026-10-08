/**
 * @layer ui/viewport/2d
 *
 * Mounts a three.js Line/LineSegments at an entity's position and disposes its geometry +
 * material when the object changes or unmounts (R9).
 */

import { useEffect } from 'react';
import type * as THREE from 'three';
import type { Vec3 } from '@core/model/types';

interface PlacedLineObjectProps {
  object: THREE.Line | THREE.LineSegments;
  position: Vec3;
}

export function PlacedLineObject({ object, position }: PlacedLineObjectProps): React.ReactElement {
  useEffect(() => {
    return () => {
      object.geometry.dispose();
      (object.material as THREE.Material).dispose();
    };
  }, [object]);

  // The object's own position is its float32-safe anchor (see dimensionGeometry); add it in float64.
  const placed: Vec3 = [
    position[0] + object.position.x,
    position[1] + object.position.y,
    position[2] + object.position.z,
  ];
  return <primitive object={object} position={placed} />;
}
