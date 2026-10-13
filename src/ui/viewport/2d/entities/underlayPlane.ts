// Image underlay plane over [0, width] × [0, height] (lower-left at the origin), v = 1 at the top (upright).

import * as THREE from 'three';

export function underlayPlaneGeometry(width: number, height: number): THREE.PlaneGeometry {
  const geometry = new THREE.PlaneGeometry(width, height);
  geometry.translate(width / 2, height / 2, 0);
  return geometry;
}
