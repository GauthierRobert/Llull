/** @layer ui/viewport/2d — closed ellipse outline as LineSegments vertex data (z = 0). */

import * as THREE from 'three';

export function ellipseSegmentsGeometry(
  cx: number,
  cy: number,
  radiusX: number,
  radiusY: number,
  segments: number,
): THREE.BufferGeometry {
  const verts: number[] = [];
  for (let i = 0; i < segments; i++) {
    const a0 = (i / segments) * Math.PI * 2;
    const a1 = ((i + 1) / segments) * Math.PI * 2;
    verts.push(
      cx + radiusX * Math.cos(a0),
      cy + radiusY * Math.sin(a0),
      0,
      cx + radiusX * Math.cos(a1),
      cy + radiusY * Math.sin(a1),
      0,
    );
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(verts), 3));
  return geo;
}
