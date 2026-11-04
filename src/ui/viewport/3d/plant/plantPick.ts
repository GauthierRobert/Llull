// Picking of a plant bucket through the instance BVH. Same hits as three's `InstancedMesh.raycast` (the exact per-instance test is the
// same `Mesh.raycast` on the instance's world matrix), but only the instances whose AABB the ray touches are tested, and a hit on a part
// the section plane clips away is dropped here so the next hit behind it can still be picked.

import * as THREE from 'three';
import type { Vec3 } from '@core/model/types';
import { isClippedAway } from '../review/activeClipPlanes';
import type { DrawBucket } from './plantBatchPlan';

/** Scene-index candidates for a document-space ray (ascending). */
export type CandidateSource = (origin: Vec3, direction: Vec3) => readonly number[];

const scratchMesh = new THREE.Mesh();
const scratchMatrix = new THREE.Matrix4();
const scratchInverse = new THREE.Matrix4();
const scratchRay = new THREE.Ray();
const scratchHits: THREE.Intersection[] = [];

/** Position of `value` in ascending `members`, or -1. */
export function memberPosition(members: readonly number[], value: number): number {
  let [low, high] = [0, members.length - 1];
  while (low <= high) {
    const mid = (low + high) >> 1;
    const at = members[mid] as number;
    if (at === value) return mid;
    if (at < value) low = mid + 1;
    else high = mid - 1;
  }
  return -1;
}

/** `Object3D.raycast` for the bucket's InstancedMesh (the mesh space is document space, the floating-origin group sits above it). */
export function bucketRaycast(
  bucket: Pick<DrawBucket, 'members'>,
  candidates: CandidateSource,
): (this: THREE.InstancedMesh, raycaster: THREE.Raycaster, intersects: THREE.Intersection[]) => void {
  return function raycast(this: THREE.InstancedMesh, raycaster, intersects): void {
    if (this.material === undefined || this.geometry === undefined) return;
    scratchInverse.copy(this.matrixWorld).invert();
    scratchRay.copy(raycaster.ray).applyMatrix4(scratchInverse);
    const { origin, direction } = scratchRay;
    const hits = candidates([origin.x, origin.y, origin.z], [direction.x, direction.y, direction.z]);
    scratchMesh.geometry = this.geometry;
    scratchMesh.material = this.material;
    for (const sceneIndex of hits) {
      const instanceId = memberPosition(bucket.members, sceneIndex);
      if (instanceId < 0 || instanceId >= this.count) continue;
      this.getMatrixAt(instanceId, scratchMatrix);
      scratchMesh.matrixWorld.multiplyMatrices(this.matrixWorld, scratchMatrix);
      scratchHits.length = 0;
      scratchMesh.raycast(raycaster, scratchHits);
      for (const hit of scratchHits) {
        if (isClippedAway(hit.point)) continue;
        hit.instanceId = instanceId;
        hit.object = this;
        intersects.push(hit);
      }
    }
  };
}
