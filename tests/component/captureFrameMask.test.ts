import { beforeEach, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { useStore, useViewportStore } from '@ui/store';
import { applyFrameMask } from '@ui/viewport/3d/capture/frameMask';
import { createCaptureQueue } from '@ui/viewport/3d/capture/captureQueue';
import { resetStore } from '../helpers/componentEntities';
import { localDispatch } from '../helpers/storeTestHelpers';

/** A scene as Entities builds it: one per-entity group per entity, plus one instanced batch holding both entities. */
function sceneOf(ids: readonly string[]): { scene: THREE.Scene; groups: THREE.Group[]; batch: THREE.InstancedMesh; grid: THREE.Object3D } {
  const scene = new THREE.Scene();
  const groups = ids.map((id) => {
    const group = new THREE.Group();
    group.userData = { entityId: id };
    scene.add(group);
    return group;
  });
  const batch = new THREE.InstancedMesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial(), ids.length);
  ids.forEach((_, index) => batch.setMatrixAt(index, new THREE.Matrix4().makeTranslation(index + 1, 0, 0)));
  batch.userData = { instanceIds: [...ids] };
  scene.add(batch);
  const grid = new THREE.Group();
  grid.userData = { captureExclude: true };
  scene.add(grid);
  return { scene, groups, batch, grid };
}

describe('applyFrameMask (hideLayers of capture_viewport)', () => {
  beforeEach(() => {
    resetStore();
  });

  it('hides the entities of the layers and the helpers for the draw, and puts everything back exactly', () => {
    const first = localDispatch('add_box', { size: [1, 1, 1] }).affected[0]!;
    localDispatch('add_layer', { name: 'Hide' });
    const doc = useStore.getState().document;
    const hiddenLayer = Object.values(doc.layers).find((layer) => layer.name === 'Hide')!.id;
    localDispatch('set_entity_layer', { entityId: first, layerId: hiddenLayer });
    const second = localDispatch('add_box', { size: [1, 1, 1] }).affected[0]!;
    const current = useStore.getState().document;
    const { scene, groups, batch, grid } = sceneOf([first, second]);
    const matrices = Array.from(batch.instanceMatrix.array);

    const undo = applyFrameMask(scene, current, new Set([hiddenLayer]));
    expect(groups.map((group) => group.visible)).toEqual([false, true]);
    expect(grid.visible).toBe(false);
    expect(Array.from(batch.instanceMatrix.array.slice(0, 16))).toEqual(new Array<number>(16).fill(0));
    expect(Array.from(batch.instanceMatrix.array.slice(16, 32))).toEqual(matrices.slice(16, 32));

    undo();
    expect(groups.map((group) => group.visible)).toEqual([true, true]);
    expect(grid.visible).toBe(true);
    expect(Array.from(batch.instanceMatrix.array)).toEqual(matrices);
  });

  it('leaves instances alone when no layer is hidden (the helpers are still left out)', () => {
    const only = localDispatch('add_box', { size: [1, 1, 1] }).affected[0]!;
    const { scene, batch, grid } = sceneOf([only]);
    const matrices = Array.from(batch.instanceMatrix.array);
    const undo = applyFrameMask(scene, useStore.getState().document, new Set());
    expect(Array.from(batch.instanceMatrix.array)).toEqual(matrices);
    expect(grid.visible).toBe(false);
    undo();
    expect(grid.visible).toBe(true);
  });
});

describe('overlapping hiding captures never touch the user layer filter', () => {
  beforeEach(() => {
    resetStore();
    useViewportStore.setState({ hiddenLayerIds: new Set() });
  });

  it('two queued captures plus a user toggle in between: hiddenLayerIds is the user filter before, during and after', async () => {
    const id = localDispatch('add_box', { size: [1, 1, 1] }).affected[0]!;
    const doc = useStore.getState().document;
    const layerId = doc.entities[id]!.layerId;
    const { scene, groups } = sceneOf([id]);
    const queue = createCaptureQueue();
    const order: string[] = [];
    const seenDuring: (ReadonlySet<string> | null)[] = [];

    // what CaptureRig does: mask, draw (synchronous), unmask; the png encode afterwards is async
    const capture = (name: string): Promise<void> =>
      queue.run(async () => {
        const unmask = applyFrameMask(scene, doc, new Set([layerId]));
        try {
          order.push(`${name}:draw:${groups[0]!.visible}`);
          seenDuring.push(useViewportStore.getState().hiddenLayerIds);
        } finally {
          unmask();
        }
        await Promise.resolve();
        order.push(`${name}:done`);
      });

    const first = capture('a');
    const second = capture('b');
    useViewportStore.getState().toggleLayerVisibility('user-layer'); // the user hides a layer while both captures are queued
    const userFilter = useViewportStore.getState().hiddenLayerIds;
    await Promise.all([first, second]);

    expect(order).toEqual(['a:draw:false', 'a:done', 'b:draw:false', 'b:done']);
    expect(groups[0]!.visible).toBe(true);
    expect(seenDuring.every((seen) => seen === userFilter)).toBe(true);
    expect(useViewportStore.getState().hiddenLayerIds).toBe(userFilter);
    expect([...userFilter]).toEqual(['user-layer']);
  });

  it('a task whose signal was aborted before its turn is skipped; the next one still runs', async () => {
    const queue = createCaptureQueue();
    const cancel = new AbortController();
    const ran: string[] = [];
    const slow = queue.run(async () => {
      ran.push('first');
      await Promise.resolve();
    });
    const skipped = queue.run(async () => void ran.push('skipped'), cancel.signal);
    const last = queue.run(async () => void ran.push('last'));
    cancel.abort();
    await slow;
    await expect(skipped).rejects.toThrow('cancelled');
    await last;
    expect(ran).toEqual(['first', 'last']);
  });
});
