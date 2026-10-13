/**
 * Geometry of an image underlay: a `width` × `height` plane covering [0, width] × [0, height] of the
 * work plane (lower-left at the entity origin, like `kind:'rectangle'`), UVs with v = 1 at the top
 * so the picture is upright.
 */

import * as THREE from 'three';

export function underlayPlaneGeometry(width: number, height: number): THREE.PlaneGeometry {
  const geometry = new THREE.PlaneGeometry(width, height);
  geometry.translate(width / 2, height / 2, 0);
  return geometry;
}
