// Display geometry of a backend preview mesh. World-space triangles are re-based on their first vertex (float32 attribute precision,
// floating origin): the object is placed at the anchor, whose sum with the local positions is exact in float64. Pure builder, no React.

import * as THREE from 'three';
import type { PreviewMesh } from '@ui/store/remotePreviewStore';

export interface AnchoredMesh {
  readonly geometry: THREE.BufferGeometry;
  readonly anchor: readonly [number, number, number];
}

/** @invariant local position + anchor reproduces the world position; flat normals (the triangles are unindexed). */
export function previewGeometry(mesh: Pick<PreviewMesh, 'positions'>): AnchoredMesh {
  const { positions } = mesh;
  const anchor: [number, number, number] = [positions[0] ?? 0, positions[1] ?? 0, positions[2] ?? 0];
  const local = new Float32Array(positions.length);
  for (let i = 0; i + 2 < positions.length; i += 3) {
    local[i] = (positions[i] as number) - anchor[0];
    local[i + 1] = (positions[i + 1] as number) - anchor[1];
    local[i + 2] = (positions[i + 2] as number) - anchor[2];
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(local, 3));
  geometry.computeVertexNormals();
  return { geometry, anchor };
}
