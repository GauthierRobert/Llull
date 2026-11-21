// What one capture frame leaves out, applied to the live scene for the duration of ONE synchronous draw and then undone (ASC M6a). Nothing here touches
// a store or waits for a React frame: the on-screen canvas can never show the mask, and the user's own layer filter is never written.
//   userData.entityId     per-entity group: hidden when the entity's layer is hidden
//   userData.instanceIds  instanced mesh: instances of hidden layers are collapsed to a zero matrix
//   userData.captureExclude  helper that is not part of the model (grid, gizmo, snap markers): never drawn

import * as THREE from 'three';
import type { CadDocument } from '@core/model/types';

const MATRIX_SIZE = 16;
const COLLAPSED = new Float32Array(MATRIX_SIZE);

function hiddenInstances(ids: readonly string[], doc: CadDocument, hiddenLayers: ReadonlySet<string>): number[] {
  const hidden: number[] = [];
  ids.forEach((id, index) => {
    const layerId = doc.entities[id]?.layerId;
    if (layerId !== undefined && hiddenLayers.has(layerId)) hidden.push(index);
  });
  return hidden;
}

/** Hide `hiddenLayers` (layer ids) and the capture-excluded helpers in `scene`; returns the function that puts everything back. */
export function applyFrameMask(scene: THREE.Object3D, doc: CadDocument, hiddenLayers: ReadonlySet<string>): () => void {
  const undo: (() => void)[] = [];
  scene.traverse((object) => {
    const { entityId, instanceIds, captureExclude } = object.userData as {
      entityId?: unknown;
      instanceIds?: unknown;
      captureExclude?: unknown;
    };
    const layerId = typeof entityId === 'string' ? doc.entities[entityId]?.layerId : undefined;
    if (captureExclude === true || (layerId !== undefined && hiddenLayers.has(layerId))) {
      const wasVisible = object.visible;
      object.visible = false;
      undo.push(() => {
        object.visible = wasVisible;
      });
    }
    if (object instanceof THREE.InstancedMesh && Array.isArray(instanceIds) && hiddenLayers.size > 0) {
      const hidden = hiddenInstances(instanceIds as string[], doc, hiddenLayers);
      if (hidden.length === 0) return;
      const matrices = object.instanceMatrix;
      const saved = hidden.map((index) => matrices.array.slice(index * MATRIX_SIZE, (index + 1) * MATRIX_SIZE));
      for (const index of hidden) matrices.array.set(COLLAPSED, index * MATRIX_SIZE);
      matrices.needsUpdate = true;
      undo.push(() => {
        hidden.forEach((index, at) => matrices.array.set(saved[at] ?? COLLAPSED, index * MATRIX_SIZE));
        matrices.needsUpdate = true;
      });
    }
  });
  return () => {
    for (const restore of undo.reverse()) restore();
  };
}
