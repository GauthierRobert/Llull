// three-mesh-bvh: O(log n) Mesh raycasts + BufferGeometry.computeBoundsTree/disposeBoundsTree (built per geometry by
// the mesh components). Idempotent. InstancedMesh is not patched (needs explicit wiring; instance counts stay < 10k).

import * as THREE from 'three';
import { acceleratedRaycast, computeBoundsTree, disposeBoundsTree } from 'three-mesh-bvh';

let _patched = false;

export function ensureBvhSetup(): void {
  if (_patched) return;

  THREE.Mesh.prototype.raycast = acceleratedRaycast;

  // Typed by three-mesh-bvh's `declare module 'three'`.
  THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
  THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;

  _patched = true;
}

/** @internal test-only */
export function __resetBvhSetup(): void {
  _patched = false;
}
