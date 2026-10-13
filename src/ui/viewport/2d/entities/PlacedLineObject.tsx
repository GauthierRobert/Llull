// Line/LineSegments at an entity's position; geometry + material disposed on change / unmount.

import { useEffect } from 'react';
import type * as THREE from 'three';
import type { Vec3 } from '@core/model/types';

export function PlacedLineObject({ object, position }: { object: THREE.Line | THREE.LineSegments; position: Vec3 }): React.ReactElement {
  useEffect(() => {
    return () => {
      object.geometry.dispose();
      (object.material as THREE.Material).dispose();
    };
  }, [object]);

  // The object's own position is its float32-safe anchor (see dimensionGeometry); add it in float64.
  const placed: Vec3 = [position[0] + object.position.x, position[1] + object.position.y, position[2] + object.position.z];
  return <primitive object={object} position={placed} />;
}
