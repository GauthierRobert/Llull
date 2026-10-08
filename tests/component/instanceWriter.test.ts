/**
 * writeBatchInstances: after instances move, the InstancedMesh bounds must follow them, otherwise
 * three keeps the stale first-write sphere and frustum-culls / fails to raycast moved instances.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import * as THREE from 'three';
import { useStore } from '@ui/store';
import { createEmptyDocument, type Entity } from '@core/model/types';
import { localDispatch } from '../helpers/storeTestHelpers';
import { groupEntitiesForInstancing, type InstanceBatch } from '@ui/viewport/3d/grouping';
import { writeBatchInstances } from '@ui/viewport/3d/instanceWriter';

function onlyBatch(): InstanceBatch {
  const { entities, order } = useStore.getState().document;
  const list = order.map((id) => entities[id]).filter((e): e is Entity => e !== undefined);
  const batch = [...groupEntitiesForInstancing(list).values()][0];
  if (!batch) throw new Error('no batch');
  return batch;
}

function newMesh(): THREE.InstancedMesh {
  return new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), undefined, 1);
}

describe('writeBatchInstances', () => {
  beforeEach(() => {
    useStore.setState({ document: createEmptyDocument(), lastSummary: null });
  });

  it('refreshes the bounding sphere when an instance moves', () => {
    const id = localDispatch('add_box', { size: [1, 1, 1] }).affected[0]!;
    const mesh = newMesh();
    writeBatchInstances(mesh, onlyBatch(), new Set());
    expect(mesh.boundingSphere?.center.x).toBeCloseTo(0);

    localDispatch('move_entity', { id, delta: [100, 0, 0] });
    writeBatchInstances(mesh, onlyBatch(), new Set());
    expect(mesh.boundingSphere?.center.x).toBeCloseTo(100);
  });

  it('tints selected instances', () => {
    localDispatch('add_box', { size: [1, 1, 1] });
    const batch = onlyBatch();
    const mesh = newMesh();
    writeBatchInstances(mesh, batch, new Set());
    const plain = Array.from(mesh.instanceColor!.array.slice(0, 3));
    writeBatchInstances(mesh, batch, new Set([batch.entities[0]!.id]));
    expect(Array.from(mesh.instanceColor!.array.slice(0, 3))).not.toEqual(plain);
  });
});
