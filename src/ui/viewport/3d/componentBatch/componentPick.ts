// Instance matrices and world boxes of a component batch, and the ray index over them. The instance BVH (`@core/geometry/instanceBvh`, the
// plant renderer's) replaces the O(N) scan of three's `InstancedMesh.raycast`; the exact per-instance test stays three-mesh-bvh's
// accelerated `Mesh.raycast` on the shared geometry (`bucketRaycast`), so hits equal the brute-force ones.

import * as THREE from 'three';
import { type InstanceBvh, buildInstanceBvh, packBoxes, type PackedBoxes } from '@core/geometry/instanceBvh';
import type { Entity, EntityId, Vec3 } from '@core/model/types';

const DUMMY = new THREE.Object3D();

/** Instance matrix: scale, then rotate about the component origin (Euler XYZ), then translate (`instanceToWorld`). */
function composeInstanceMatrix(instance: Entity, target: THREE.Matrix4): THREE.Matrix4 {
  DUMMY.position.set(instance.position[0], instance.position[1], instance.position[2]);
  DUMMY.rotation.set(instance.rotation[0], instance.rotation[1], instance.rotation[2]);
  const scale = instance.kind === 'instance' ? instance.scale : undefined;
  DUMMY.scale.set(scale?.[0] ?? 1, scale?.[1] ?? 1, scale?.[2] ?? 1);
  DUMMY.updateMatrix();
  return target.copy(DUMMY.matrix);
}

/** Row-major-by-instance matrices (16 floats each, three's column-major layout) of `ids`; a missing entity gets the identity. */
export function instanceMatrices(ids: readonly EntityId[], entities: Readonly<Record<EntityId, Entity>>): Float32Array {
  const out = new Float32Array(ids.length * 16);
  const matrix = new THREE.Matrix4();
  ids.forEach((id, index) => {
    const instance = entities[id];
    if (instance === undefined) matrix.identity();
    else composeInstanceMatrix(instance, matrix);
    matrix.toArray(out, index * 16);
  });
  return out;
}

const CORNER = new THREE.Vector3();

/** World AABB of the local box under each matrix of `matrices`, packed for `buildInstanceBvh`. */
export function worldBoxes(matrices: Float32Array, localBox: THREE.Box3): PackedBoxes {
  const count = matrices.length / 16;
  const matrix = new THREE.Matrix4();
  const boxes: { min: Vec3; max: Vec3 }[] = [];
  const empty = localBox.isEmpty();
  for (let index = 0; index < count; index++) {
    matrix.fromArray(matrices, index * 16);
    const min = [Infinity, Infinity, Infinity] as [number, number, number];
    const max = [-Infinity, -Infinity, -Infinity] as [number, number, number];
    for (let corner = 0; corner < 8 && !empty; corner++) {
      CORNER.set(
        corner & 1 ? localBox.max.x : localBox.min.x,
        corner & 2 ? localBox.max.y : localBox.min.y,
        corner & 4 ? localBox.max.z : localBox.min.z,
      ).applyMatrix4(matrix);
      min[0] = Math.min(min[0], CORNER.x);
      min[1] = Math.min(min[1], CORNER.y);
      min[2] = Math.min(min[2], CORNER.z);
      max[0] = Math.max(max[0], CORNER.x);
      max[1] = Math.max(max[1], CORNER.y);
      max[2] = Math.max(max[2], CORNER.z);
    }
    if (empty) {
      const origin = new THREE.Vector3().setFromMatrixPosition(matrix);
      boxes.push({ min: [origin.x, origin.y, origin.z], max: [origin.x, origin.y, origin.z] });
    } else boxes.push({ min, max });
  }
  return packBoxes(boxes);
}

/** Ray index over the batch: `rayQuery` returns the instance indices (ascending) whose world box the ray touches. */
export function buildPickIndex(boxes: PackedBoxes): InstanceBvh {
  return buildInstanceBvh(boxes);
}

/** Local bounding box of `geometry` (empty box for an empty geometry). */
export function localBoxOf(geometry: THREE.BufferGeometry): THREE.Box3 {
  geometry.computeBoundingBox();
  return geometry.boundingBox ?? new THREE.Box3();
}
