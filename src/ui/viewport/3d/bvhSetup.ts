/**
 * @layer ui/viewport/3d
 *
 * BVH prototype patch — accelerates THREE.Mesh raycasting from O(n) to O(log n)
 * for large triangle counts. Called ONCE at app startup (idempotent guard prevents
 * double-patching under React StrictMode double-invoke).
 *
 * Patched prototypes:
 *   - THREE.Mesh.prototype.raycast          → acceleratedRaycast
 *   - THREE.BufferGeometry.prototype.computeBoundsTree  (added)
 *   - THREE.BufferGeometry.prototype.disposeBoundsTree  (added)
 *
 * Usage:
 *   import { ensureBvhSetup } from './bvhSetup';
 *   ensureBvhSetup(); // call once at viewport init
 *
 * Then, inside a useEffect for each non-instanced mesh geometry:
 *   geometry.computeBoundsTree();   // build
 *   geometry.disposeBoundsTree();   // free on unmount
 *
 * InstancedMesh: NOT patched here. THREE.InstancedMesh.raycast already tests only
 * the shared bounding sphere per-instance (O(n) instances, O(1) per test) then falls
 * through to geometry tests — adding BVH to the shared geometry would help the
 * per-instance geometry step, but three-mesh-bvh instanced support (MeshBVHHelper +
 * acceleratedRaycast path) requires explicit InstancedMesh wiring that is non-trivial
 * and out of scope. Instance counts in llull are typically low (< 10k) so per-instance
 * BVH is left to a future pass.
 */

import * as THREE from 'three';
import {
  acceleratedRaycast,
  computeBoundsTree,
  disposeBoundsTree,
} from 'three-mesh-bvh';

/** True after the first successful patch; prevents double-application. */
let _patched = false;

/**
 * Patches THREE.Mesh + THREE.BufferGeometry prototypes with three-mesh-bvh
 * acceleration. Idempotent — safe to call multiple times (e.g. React StrictMode).
 *
 * @pure no side effects beyond the one-time prototype mutation
 */
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

/**
 * Exposed for testing only — resets the idempotency flag so tests can verify
 * the patch is applied from a clean state.
 *
 * @internal
 */
export function __resetBvhSetup(): void {
  _patched = false;
}
