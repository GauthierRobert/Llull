/**
 * Component tests for InstancedRenderer + instancing integration.
 *
 * Since jsdom cannot run WebGL (no Canvas / THREE.WebGLRenderer), we test
 * the grouping layer exhaustively (unit tests in grouping.test.ts) and verify
 * the integration path through the store + grouping helpers here:
 *
 * 1. Grouping produces the expected number of batches.
 * 2. 100 identical boxes → 1 batch with 100 entries.
 * 3. 100 unique-color boxes → 100 batches with 1 entry each.
 * 4. entityIdFromInstanceId correctly maps back to entity ids.
 * 5. Non-batchable entities (cone) are excluded from batches.
 *
 * The InstancedRenderer React component itself (WebGL) is not renderable in
 * jsdom; we verify the grouping contract that drives it instead (R11: assert
 * observable behavior, not internals).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { __resetIdCounter } from '@lib/id';
import { useStore } from '@ui/store';
import { createEmptyDocument } from '@core/model/types';
import { localDispatch } from '../helpers/storeTestHelpers';
import {
  groupEntitiesForInstancing,
  entityIdFromInstanceId,
  isBatchable,
} from '../../src/ui/viewport/3d/grouping';
import type { Entity } from '@core/model/types';

function resetStore(): void {
  useStore.setState({ document: createEmptyDocument(), lastSummary: null });
}

function getVisibleEntities(): Entity[] {
  const { entities, order } = useStore.getState().document;
  return order.map((id) => entities[id]).filter((e): e is Entity => e !== undefined);
}

// ---------------------------------------------------------------------------
// Integration: dispatch → store entities → grouping
// ---------------------------------------------------------------------------

describe('InstancedRenderer integration — 100 identical boxes → 1 batch', () => {
  beforeEach(() => {
    __resetIdCounter();
    resetStore();
  });

  it('produces exactly 1 batch for 100 identical boxes', () => {
    // Dispatch 100 add_box commands with the same parameters.
    for (let i = 0; i < 100; i++) {
      localDispatch('add_box', { size: [10, 20, 30] });
    }

    const entities = getVisibleEntities();
    expect(entities).toHaveLength(100);

    const batches = groupEntitiesForInstancing(entities);
    expect(batches.size).toBe(1);

    const [batch] = batches.values();
    expect(batch).toBeDefined();
    expect(batch!.entities).toHaveLength(100);
    expect(batch!.kind).toBe('box');
  });

  it('all 100 entity ids are reachable via entityIdFromInstanceId', () => {
    for (let i = 0; i < 100; i++) {
      localDispatch('add_box', { size: [10, 20, 30] });
    }

    const entities = getVisibleEntities();
    const batches = groupEntitiesForInstancing(entities);
    const [batch] = batches.values();

    const allIds = new Set<string>(entities.map((e) => e.id));
    for (let i = 0; i < 100; i++) {
      const id = entityIdFromInstanceId(batch!, i);
      expect(id).toBeDefined();
      expect(allIds.has(id!)).toBe(true);
    }
  });
});

describe('InstancedRenderer integration — unique-color boxes → separate batches', () => {
  beforeEach(() => {
    __resetIdCounter();
    resetStore();
  });

  it('10 boxes with unique colors → 10 batches with 1 instance each', () => {
    const colors = [
      '#ff0000', '#00ff00', '#0000ff', '#ffff00', '#ff00ff',
      '#00ffff', '#ffffff', '#aaaaaa', '#555555', '#123456',
    ];
    for (const color of colors) {
      localDispatch('add_box', { size: [5, 5, 5], color });
    }

    const entities = getVisibleEntities();
    const batches = groupEntitiesForInstancing(entities);
    expect(batches.size).toBe(10);

    for (const batch of batches.values()) {
      expect(batch.entities).toHaveLength(1);
    }
  });
});

describe('InstancedRenderer integration — non-batchable entities', () => {
  beforeEach(() => {
    __resetIdCounter();
    resetStore();
  });

  it('cone entities are not batchable (isBatchable returns false)', () => {
    const result = localDispatch('add_cone', { radius: 2, height: 5 });
    const entityId = result.affected[0]!;
    const entity = useStore.getState().document.entities[entityId]!;
    expect(isBatchable(entity)).toBe(false);
  });

  it('cone entities are excluded from groupEntitiesForInstancing', () => {
    localDispatch('add_cone', { radius: 2, height: 5 });
    localDispatch('add_box', { size: [1, 2, 3] });

    const entities = getVisibleEntities();
    const batches = groupEntitiesForInstancing(entities);

    // Only the box should be in a batch.
    expect(batches.size).toBe(1);
    const [batch] = batches.values();
    expect(batch!.kind).toBe('box');
    expect(batch!.entities).toHaveLength(1);
  });

  it('torus entities are not batchable', () => {
    const result = localDispatch('add_torus', { ringRadius: 4, tubeRadius: 1 });
    const entityId = result.affected[0]!;
    const entity = useStore.getState().document.entities[entityId]!;
    expect(isBatchable(entity)).toBe(false);
  });

  it('wedge entities are not batchable', () => {
    const result = localDispatch('add_wedge', { size: [3, 3, 3] });
    const entityId = result.affected[0]!;
    const entity = useStore.getState().document.entities[entityId]!;
    expect(isBatchable(entity)).toBe(false);
  });

  it('pyramid entities are not batchable', () => {
    const result = localDispatch('add_pyramid', { baseWidth: 4, baseDepth: 4, height: 6 });
    const entityId = result.affected[0]!;
    const entity = useStore.getState().document.entities[entityId]!;
    expect(isBatchable(entity)).toBe(false);
  });
});

describe('InstancedRenderer integration — mixed batchable + non-batchable', () => {
  beforeEach(() => {
    __resetIdCounter();
    resetStore();
  });

  it('5 boxes + 3 cones → 1 batch (boxes) and 0 batches for cones', () => {
    for (let i = 0; i < 5; i++) {
      localDispatch('add_box', { size: [2, 4, 6] });
    }
    for (let i = 0; i < 3; i++) {
      localDispatch('add_cone', { radius: 1, height: 3 });
    }

    const entities = getVisibleEntities();
    expect(entities).toHaveLength(8);

    const batches = groupEntitiesForInstancing(entities);
    expect(batches.size).toBe(1);

    const [batch] = batches.values();
    expect(batch!.entities).toHaveLength(5);
    expect(batch!.kind).toBe('box');
  });
});

describe('InstancedRenderer integration — cylinder and sphere batching', () => {
  beforeEach(() => {
    __resetIdCounter();
    resetStore();
  });

  it('3 identical cylinders → 1 batch', () => {
    for (let i = 0; i < 3; i++) {
      localDispatch('add_cylinder', { radius: 5, height: 12 });
    }

    const entities = getVisibleEntities();
    const batches = groupEntitiesForInstancing(entities);
    expect(batches.size).toBe(1);
    const [batch] = batches.values();
    expect(batch!.kind).toBe('cylinder');
    expect(batch!.entities).toHaveLength(3);
  });

  it('3 identical spheres → 1 batch', () => {
    for (let i = 0; i < 3; i++) {
      localDispatch('add_sphere', { radius: 7 });
    }

    const entities = getVisibleEntities();
    const batches = groupEntitiesForInstancing(entities);
    expect(batches.size).toBe(1);
    const [batch] = batches.values();
    expect(batch!.kind).toBe('sphere');
    expect(batch!.entities).toHaveLength(3);
  });

  it('mixed box + cylinder + sphere → 3 separate batches', () => {
    localDispatch('add_box', { size: [10, 10, 10] });
    localDispatch('add_cylinder', { radius: 5, height: 12 });
    localDispatch('add_sphere', { radius: 7 });

    const entities = getVisibleEntities();
    const batches = groupEntitiesForInstancing(entities);
    expect(batches.size).toBe(3);
  });
});

describe('InstancedRenderer integration — entityIdFromInstanceId', () => {
  beforeEach(() => {
    __resetIdCounter();
    resetStore();
  });

  it('instanceId maps to a valid entity id in the document', () => {
    for (let i = 0; i < 5; i++) {
      localDispatch('add_box', { size: [3, 3, 3] });
    }

    const entities = getVisibleEntities();
    const batches = groupEntitiesForInstancing(entities);
    const [batch] = batches.values();

    const entityIds = new Set(useStore.getState().document.order);
    for (let i = 0; i < 5; i++) {
      const id = entityIdFromInstanceId(batch!, i);
      expect(id).toBeDefined();
      expect(entityIds.has(id!)).toBe(true);
    }
  });

  it('each instanceId maps to a distinct entity id (no duplicates)', () => {
    for (let i = 0; i < 5; i++) {
      localDispatch('add_box', { size: [3, 3, 3] });
    }

    const entities = getVisibleEntities();
    const batches = groupEntitiesForInstancing(entities);
    const [batch] = batches.values();

    const seen = new Set<string>();
    for (let i = 0; i < 5; i++) {
      const id = entityIdFromInstanceId(batch!, i);
      expect(id).toBeDefined();
      expect(seen.has(id!)).toBe(false);
      seen.add(id!);
    }
  });
});
