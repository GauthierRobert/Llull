import * as THREE from 'three';
import { useEffect } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import { planScene } from '@core/geometry/renderPlan';
import type { CadDocument, Entity } from '@core/model/types';
import { isPlantBatchable } from '@ui/viewport/3d/plant/plantBatchPlan';
import { useStore } from '@ui/store';
import { useTintStore } from '@ui/store/tintStore';
import { resetStore } from '../helpers/componentEntities';
import { synRackDocument } from '../helpers/synRack';

/** What is on screen now: mounted per-entity meshes, the instanced batches of the last render, mounted plant buckets. */
const screen = vi.hoisted(() => ({
  instancedRenders: 0,
  perEntity: new Map<string, number>(),
  instanced: [] as string[],
  buckets: new Map<string, string[]>(),
}));

vi.mock('@ui/viewport/3d/entities/solidMeshes', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@ui/viewport/3d/entities/solidMeshes')>();
  const Record = ({ entity }: { entity: { id: string } }): null => {
    useEffect(() => {
      screen.perEntity.set(entity.id, (screen.perEntity.get(entity.id) ?? 0) + 1);
      return () => {
        screen.perEntity.set(entity.id, (screen.perEntity.get(entity.id) ?? 1) - 1);
      };
    }, [entity.id]);
    return null;
  };
  return { SOLID_MESHES: Object.fromEntries(Object.keys(actual.SOLID_MESHES).map((kind) => [kind, Record])) };
});
vi.mock('@ui/viewport/3d/InstancedRenderer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@ui/viewport/3d/InstancedRenderer')>();
  return {
    ...actual,
    InstancedRenderer: ({ batches }: { batches: Map<string, { entities: { id: string }[] }> }): null => {
      screen.instancedRenders++;
      screen.instanced = [...batches.values()].flatMap((batch) => batch.entities.map((entity) => entity.id));
      return null;
    },
  };
});
vi.mock('@ui/viewport/3d/plant/PlantBucketMesh', () => ({
  PlantBucketMesh: ({ bucket }: { bucket: { key: string; ids: string[] } }): null => {
    screen.buckets.set(bucket.key, bucket.ids);
    useEffect(() => () => void screen.buckets.delete(bucket.key), [bucket.key]);
    return null;
  },
}));
vi.mock('@ui/viewport/3d/GridAnnotations3D', () => ({ GridAnnotations3D: (): null => null }));
vi.mock('@ui/viewport/3d/preview/PreviewLayer', () => ({ PreviewLayer: (): null => null }));
vi.mock('@ui/viewport/liveFx/LiveFxLayer', () => ({ LiveFxLayer: (): null => null }));
vi.mock('@ui/viewport/liveFx/LiveTransitionGroup', () => ({
  LiveTransitionGroup: ({ children }: { children: React.ReactNode }): React.ReactNode => children,
}));

import { Entities } from '@ui/viewport/3d/Entities';
import { PlantCameraContext } from '@ui/viewport/3d/plant/PlantCameraProvider';
import { PlantCameraStore, type PlantCameraView } from '@ui/viewport/3d/plant/plantCameraStore';
import { planCameraOf } from '@ui/viewport/3d/plant/plantPlanCamera';
import { LEVEL_CULLED, planRender } from '@core/geometry/renderPlan';

/** A camera that sees the whole scene; `moving` keeps size-culled instances, so every visible entity is drawn by exactly one path. */
function viewOf(document: CadDocument, patch: Partial<PlantCameraView> = {}, distance = 1): PlantCameraView {
  const scene = planScene(document);
  const min = [Infinity, Infinity, Infinity] as [number, number, number];
  const max = [-Infinity, -Infinity, -Infinity] as [number, number, number];
  for (const { aabb } of scene.instances)
    for (let axis = 0; axis < 3; axis++) {
      min[axis] = Math.min(min[axis] as number, aabb.min[axis] as number);
      max[axis] = Math.max(max[axis] as number, aabb.max[axis] as number);
    }
  const centre = new THREE.Vector3((min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2);
  const radius = new THREE.Vector3(...min).distanceTo(new THREE.Vector3(...max));
  const camera = new THREE.PerspectiveCamera(45, 16 / 9, 1, radius * 10 * distance);
  camera.position.copy(centre).add(new THREE.Vector3(radius * 0.6, -radius * 1.2, radius * 0.9).multiplyScalar(distance));
  camera.lookAt(centre);
  camera.updateMatrixWorld();
  return { camera, width: 1920, height: 1080, version: 0, moving: true, ...patch };
}

const treeOf = (store: PlantCameraStore | null): React.ReactElement =>
  store === null ? (
    <Entities />
  ) : (
    <PlantCameraContext.Provider value={store}>
      <Entities />
    </PlantCameraContext.Provider>
  );

const tree = (view: PlantCameraView | null): React.ReactElement => treeOf(view === null ? null : new PlantCameraStore(view));

/** Asserts every entity of `document` is on screen exactly once across the per-entity path and the plant buckets; returns the batch count. */
function expectEachDrawnOnce(document: CadDocument): number {
  const batch = [...screen.buckets.values()].flat();
  const counts = new Map<string, number>();
  for (const id of [...batch, ...screen.instanced]) counts.set(id, (counts.get(id) ?? 0) + 1);
  for (const [id, mounted] of screen.perEntity) if (mounted > 0) counts.set(id, (counts.get(id) ?? 0) + mounted);
  for (const id of document.order) expect(counts.get(id), id).toBe(1);
  expect(counts.size).toBe(document.order.length);
  return batch.length;
}

describe('Entities with the plant batch renderer', () => {
  beforeEach(() => {
    screen.perEntity.clear();
    screen.instanced = [];
    screen.instancedRenders = 0;
    useTintStore.getState().setTints(new Map());
    screen.buckets.clear();
    resetStore();
  });

  it('draws every visible entity exactly once when a plan exists', () => {
    const document = synRackDocument(8);
    useStore.setState({ document });
    render(tree(viewOf(document)));
    expect(expectEachDrawnOnce(document)).toBeGreaterThan(1000);
  });

  it('falls back to the per-entity path while the camera is unplannable (zero-size canvas)', () => {
    const document = synRackDocument(8);
    useStore.setState({ document });
    render(tree(viewOf(document, { width: 0, height: 0 })));
    expect(expectEachDrawnOnce(document)).toBe(0);
  });

  it('falls back to the per-entity path outside a canvas (no camera view)', () => {
    const document = synRackDocument(8);
    useStore.setState({ document });
    render(tree(null));
    expect(expectEachDrawnOnce(document)).toBe(0);
  });

  it('never mixes a stale plan with the edited scene: each entity is drawn once after a delete', () => {
    const document = synRackDocument(8);
    useStore.setState({ document });
    const view = viewOf(document);
    render(tree(view));
    const removed = new Set(document.order.slice(0, 40));
    const edited: CadDocument = {
      ...document,
      order: document.order.filter((id) => !removed.has(id)),
      entities: Object.fromEntries(Object.entries(document.entities).filter(([id]) => !removed.has(id))),
    };
    act(() => useStore.setState({ document: edited }));
    expect(expectEachDrawnOnce(edited)).toBeGreaterThan(1000);
  });

  it('draws a tinted entity per entity and every other once', () => {
    const document = synRackDocument(8);
    useStore.setState({ document });
    render(tree(viewOf(document)));
    const tinted = [...screen.buckets.values()][0]?.[0] as string;
    act(() => useTintStore.getState().setTints(new Map([[tinted, '#ff0000']])));
    expect(screen.perEntity.get(tinted)).toBe(1);
    expect([...screen.buckets.values()].flat()).not.toContain(tinted);
    expectEachDrawnOnce(document);
  });

  it('leaves small documents to the per-entity path', () => {
    const document = synRackDocument(1);
    useStore.setState({ document });
    render(tree(viewOf(document)));
    expect(expectEachDrawnOnce(document)).toBe(0);
  });

  it('does not re-render a small document when the camera view is bumped', () => {
    const document = synRackDocument(1);
    useStore.setState({ document });
    const view = viewOf(document);
    const store = new PlantCameraStore(view);
    render(treeOf(store));
    const before = screen.instancedRenders;
    expect(before).toBeGreaterThan(0);
    act(() => store.publish(view.camera, 1920, 1080, true));
    act(() => store.publish(view.camera, 1920, 1080, false));
    expect(screen.instancedRenders).toBe(before);
    expect(store.active).toBe(false);
  });

  it('re-renders a plant document on a camera bump (the plan follows the camera)', () => {
    const document = synRackDocument(8);
    useStore.setState({ document });
    const view = viewOf(document);
    const store = new PlantCameraStore(view);
    render(treeOf(store));
    expect(store.active).toBe(true);
    const before = screen.instancedRenders;
    act(() => store.publish(view.camera, 1920, 1080, false));
    expect(screen.instancedRenders).toBeGreaterThan(before);
  });

  it('settled: covered, size-culled instances are drawn by neither path', () => {
    const document = synRackDocument(8);
    useStore.setState({ document });
    const view = viewOf(document, { moving: false }, 40);
    const base = planCameraOf(view.camera, [0, 0, 0], view.width, view.height);
    const scene = planScene(document);
    const culled = planRender(scene, base!, { multiDraw: true, quality: 'medium' }).levels;
    const culledIds = scene.instances
      .filter((instance, index) => culled[index] === LEVEL_CULLED && isPlantBatchable(document.entities[instance.id] as Entity))
      .map((instance) => instance.id);
    expect(culledIds.length).toBeGreaterThan(0);
    render(tree(view));
    const batch = new Set([...screen.buckets.values()].flat());
    for (const id of culledIds) {
      expect(batch.has(id), id).toBe(false);
      expect(screen.instanced.includes(id), id).toBe(false);
      expect(screen.perEntity.get(id) ?? 0, id).toBe(0);
    }
  });
});
