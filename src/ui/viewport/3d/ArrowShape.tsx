// Arrow along +Y of its parent group: cylinder shaft + cone head, `length` total. Shared by the aero and analysis glyph overlays.

import React from 'react';
import type * as THREE from 'three';

export function ArrowShape({
  material,
  length,
  head,
  radius,
  renderOrder,
}: {
  material: THREE.Material;
  length: number;
  head: number;
  radius: number;
  renderOrder: number;
}): React.ReactElement {
  return (
    <>
      <mesh material={material} position={[0, (length - head) / 2, 0]} renderOrder={renderOrder}>
        <cylinderGeometry args={[radius, radius, length - head, 8]} />
      </mesh>
      <mesh material={material} position={[0, length - head / 2, 0]} renderOrder={renderOrder}>
        <coneGeometry args={[radius * 3, head, 12]} />
      </mesh>
    </>
  );
}
