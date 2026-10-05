/**
 * @layer ui/viewport/3d
 *
 * BVH prototype patch — accelerates THREE.Mesh raycasting from O(n) to O(log n) for large
 * triangle counts. Called ONCE at viewport init; idempotent (safe under React StrictMode).
 * Patches `Mesh.prototype.raycast` and adds `BufferGeometry.computeBoundsTree` /
 * `disposeBoundsTree`; mesh components build the tree per geometry and free it on unmount.
 *
 * InstancedMesh is NOT patched: three-mesh-bvh's instanced support needs explicit wiring that is
 * out of scope while instance counts stay low (< 10k).
 */

import * as THREE from 'three';
import { acceleratedRaycast, computeBoundsTree, disposeBoundsTree } from 'three-mesh-bvh';

/** True after the first successful patch; prevents double-application. */
let _patched = false;

/** Patches the THREE.Mesh + THREE.BufferGeometry prototypes with three-mesh-bvh; later calls are no-ops. */
export function ensureBvhSetup(): void {
  if (_patched) return;

  // Accelerate Mesh.raycast with BVH traversal.
  THREE.Mesh.prototype.raycast = acceleratedRaycast;

  // Add computeBoundsTree / disposeBoundsTree to every BufferGeometry instance.
  // Types are augmented by three-mesh-bvh's `declare module 'three'` block.
  THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
  THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;

  _patched = true;
}

/** @internal Test-only: resets the idempotency flag so the patch can be re-applied. */
export function __resetBvhSetup(): void {
  _patched = false;
}
