// Per-instance matrices + colors of a batch into an InstancedMesh, then a bounds refresh (three otherwise keeps the
// FIRST matrices' sphere, so moved instances get frustum-culled and unpickable).

import * as THREE from 'three';
import type { EntityId } from '@core/model/types';
import { SELECTION_EMISSIVE, SELECTION_EMISSIVE_INTENSITY } from '../viewportPalette';
import type { InstanceBatch } from './grouping';

/** Matches useMaterialProps' emissive. */
const SELECTED_EMISSIVE = new THREE.Color(SELECTION_EMISSIVE);

/** Forces allocation of the instance color buffer. */
const WHITE = new THREE.Color(1, 1, 1);

/** Scratch reused by every (synchronous) batch write. */
const DUMMY = new THREE.Object3D();
const SCRATCH_COLOR = new THREE.Color();

export function writeBatchInstances(mesh: THREE.InstancedMesh, batch: InstanceBatch, selectionSet: ReadonlySet<EntityId>): void {
  if (!mesh.instanceColor) mesh.setColorAt(0, WHITE);

  batch.entities.forEach((entity, i) => {
    DUMMY.position.set(entity.position[0], entity.position[1], entity.position[2]);
    DUMMY.rotation.set(entity.rotation[0], entity.rotation[1], entity.rotation[2]);
    DUMMY.updateMatrix();
    mesh.setMatrixAt(i, DUMMY.matrix);

    // An assigned material's diffuse color; selection tints on top.
    SCRATCH_COLOR.set(batch.pbrMaterial ? batch.pbrMaterial.color : entity.color);
    if (selectionSet.has(entity.id)) {
      SCRATCH_COLOR.lerp(SELECTED_EMISSIVE, SELECTION_EMISSIVE_INTENSITY);
    }
    mesh.setColorAt(i, SCRATCH_COLOR);
  });

  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.computeBoundingSphere();
  mesh.computeBoundingBox();
}
