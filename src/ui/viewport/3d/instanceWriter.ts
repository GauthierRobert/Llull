/**
 * @layer ui/viewport/3d
 *
 * Writes a batch's per-instance matrices and colors into a THREE.InstancedMesh and refreshes its
 * cached bounds. Without the bounds refresh, three keeps the sphere computed from the FIRST
 * matrices, so moved instances are frustum-culled and unpickable.
 */

import * as THREE from 'three';
import type { EntityId } from '@core/model/types';
import type { InstanceBatch } from './grouping';

/** Selected-highlight tint color (hex). Matches useMaterialProps.ts emissive. */
const SELECTED_EMISSIVE = new THREE.Color('#3a7bd5');
const SELECTED_EMISSIVE_INTENSITY = 0.35;

/** White — used to force allocation of the instance color buffer. */
const WHITE = new THREE.Color(1, 1, 1);

/** Scratch objects reused by every batch write (single-threaded, synchronous). */
const DUMMY = new THREE.Object3D();
const SCRATCH_COLOR = new THREE.Color();

export function writeBatchInstances(
  mesh: THREE.InstancedMesh,
  batch: InstanceBatch,
  selectionSet: ReadonlySet<EntityId>,
): void {
  if (!mesh.instanceColor) mesh.setColorAt(0, WHITE);

  batch.entities.forEach((entity, i) => {
    DUMMY.position.set(entity.position[0], entity.position[1], entity.position[2]);
    DUMMY.rotation.set(entity.rotation[0], entity.rotation[1], entity.rotation[2]);
    DUMMY.updateMatrix();
    mesh.setMatrixAt(i, DUMMY.matrix);

    // Shaded mode with an assigned material uses its diffuse color; selection tints on top.
    SCRATCH_COLOR.set(batch.pbrMaterial ? batch.pbrMaterial.color : entity.color);
    if (selectionSet.has(entity.id)) {
      SCRATCH_COLOR.lerp(SELECTED_EMISSIVE, SELECTED_EMISSIVE_INTENSITY);
    }
    mesh.setColorAt(i, SCRATCH_COLOR);
  });

  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.computeBoundingSphere();
  mesh.computeBoundingBox();
}
