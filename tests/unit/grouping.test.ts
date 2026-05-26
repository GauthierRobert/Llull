/**
 * Unit tests for the pure grouping helper in `src/ui/viewport/3d/grouping.ts`.
 *
 * Covers:
 * - entityRenderKey: returns null for non-batchable kinds, correct key for batchable.
 * - isBatchable: correct predicate.
 * - groupEntitiesForInstancing: empty input, all-singletons, all-identical, mixed.
 * - Sort determinism: entities within a batch are sorted by id (ascending, lexicographic).
 * - entityIdFromInstanceId: correct forward/backward mapping.
 */

import { describe, it, expect } from 'vitest';
import type { Entity, BoxEntity, CylinderEntity, SphereEntity } from '@core/model/types';
import {
  entityRenderKey,
  isBatchable,
  groupEntitiesForInstancing,
  entityIdFromInstanceId,
} from '../../src/ui/viewport/3d/grouping';

// ---------------------------------------------------------------------------
// Test entity factories (only the fields used by grouping logic)
// ---------------------------------------------------------------------------

function makeBox(
  id: string,
  size: [number, number, number] = [10, 20, 30],
  color = '#c8553d',
  layerId = 'layer-default',
): BoxEntity {
  return {
    id,
    kind: 'box',
    size,
    position: [0, 0, 0],
    rotation: [0, 0, 0],
    color,
    layerId,
  };
}

function makeCylinder(
  id: string,
  radius = 5,
  height = 12,
  color = '#4488aa',
  layerId = 'layer-default',
): CylinderEntity {
  return {
    id,
    kind: 'cylinder',
    radius,
    height,
    position: [0, 0, 0],
    rotation: [0, 0, 0],
    color,
    layerId,
  };
}

function makeSphere(
  id: string,
  radius = 7,
  color = '#ff0000',
  layerId = 'layer-default',
): SphereEntity {
  return {
    id,
    kind: 'sphere',
    radius,
    position: [0, 0, 0],
    rotation: [0, 0, 0],
    color,
    layerId,
  };
}

/** A non-batchable entity (cone kind — v1 bail-out). */
function makeConeStub(id: string): Entity {
  return {
    id,
    kind: 'cone',
    radius: 3,
    height: 6,
    position: [0, 0, 0],
    rotation: [0, 0, 0],
    color: '#aabbcc',
    layerId: 'layer-default',
  } as Entity;
}

// ---------------------------------------------------------------------------
// entityRenderKey
// ---------------------------------------------------------------------------

describe('entityRenderKey', () => {
  it('returns null for non-batchable kind (cone)', () => {
    expect(entityRenderKey(makeConeStub('e1'))).toBeNull();
  });

  it('returns a non-null string for box', () => {
    const key = entityRenderKey(makeBox('b1', [10, 20, 30]));
    expect(key).not.toBeNull();
    expect(typeof key).toBe('string');
  });

  it('includes kind, size, color, layerId in box key', () => {
    const key = entityRenderKey(makeBox('b1', [10, 20, 30], '#c8553d', 'layer-default'));
    expect(key).toContain('box');
    expect(key).toContain('#c8553d');
    expect(key).toContain('layer-default');
  });

  it('two boxes with same params → same key', () => {
    const k1 = entityRenderKey(makeBox('b1', [5, 10, 15], '#aabbcc', 'layer-default'));
    const k2 = entityRenderKey(makeBox('b2', [5, 10, 15], '#aabbcc', 'layer-default'));
    expect(k1).toBe(k2);
  });

  it('two boxes with different size → different key', () => {
    const k1 = entityRenderKey(makeBox('b1', [5, 10, 15]));
    const k2 = entityRenderKey(makeBox('b2', [5, 10, 16]));
    expect(k1).not.toBe(k2);
  });

  it('two boxes with different color → different key', () => {
    const k1 = entityRenderKey(makeBox('b1', [1, 1, 1], '#ff0000'));
    const k2 = entityRenderKey(makeBox('b2', [1, 1, 1], '#00ff00'));
    expect(k1).not.toBe(k2);
  });

  it('two boxes on different layers → different key', () => {
    const k1 = entityRenderKey(makeBox('b1', [1, 1, 1], '#ffffff', 'layer-a'));
    const k2 = entityRenderKey(makeBox('b2', [1, 1, 1], '#ffffff', 'layer-b'));
    expect(k1).not.toBe(k2);
  });

  it('cylinder key contains kind, radius, height, color, layerId', () => {
    const key = entityRenderKey(makeCylinder('c1', 5, 12, '#4488aa', 'layer-default'));
    expect(key).toContain('cylinder');
    expect(key).toContain('#4488aa');
    expect(key).toContain('layer-default');
    expect(key).not.toBeNull();
  });

  it('sphere key contains kind, radius, color, layerId', () => {
    const key = entityRenderKey(makeSphere('s1', 7, '#ff0000', 'layer-default'));
    expect(key).toContain('sphere');
    expect(key).toContain('#ff0000');
    expect(key).toContain('layer-default');
    expect(key).not.toBeNull();
  });

  it('box and cylinder with same numeric params have different keys (kind differs)', () => {
    const boxKey = entityRenderKey(makeBox('b1', [5, 12, 5]));
    const cylKey = entityRenderKey(makeCylinder('c1', 5, 12));
    expect(boxKey).not.toBe(cylKey);
  });
});

// ---------------------------------------------------------------------------
// isBatchable
// ---------------------------------------------------------------------------

describe('isBatchable', () => {
  it('returns true for box', () => {
    expect(isBatchable(makeBox('b1'))).toBe(true);
  });

  it('returns true for cylinder', () => {
    expect(isBatchable(makeCylinder('c1'))).toBe(true);
  });

  it('returns true for sphere', () => {
    expect(isBatchable(makeSphere('s1'))).toBe(true);
  });

  it('returns false for cone (non-batchable in v1)', () => {
    expect(isBatchable(makeConeStub('e1'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// groupEntitiesForInstancing
// ---------------------------------------------------------------------------

describe('groupEntitiesForInstancing — empty input', () => {
  it('returns an empty map for an empty entity array', () => {
    const result = groupEntitiesForInstancing([]);
    expect(result.size).toBe(0);
  });
});

describe('groupEntitiesForInstancing — all singletons (unique geometry)', () => {
  it('returns one batch per entity when all have unique geometry params', () => {
    const entities: Entity[] = [
      makeBox('b1', [1, 2, 3]),
      makeBox('b2', [4, 5, 6]),
      makeBox('b3', [7, 8, 9]),
    ];
    const result = groupEntitiesForInstancing(entities);
    expect(result.size).toBe(3);
    for (const batch of result.values()) {
      expect(batch.entities).toHaveLength(1);
    }
  });

  it('entities with different kinds are in separate batches', () => {
    const entities: Entity[] = [
      makeBox('b1'),
      makeCylinder('c1'),
      makeSphere('s1'),
    ];
    const result = groupEntitiesForInstancing(entities);
    expect(result.size).toBe(3);
  });
});

describe('groupEntitiesForInstancing — all identical (same geometry)', () => {
  it('100 identical boxes → 1 batch with 100 entities', () => {
    const entities: Entity[] = Array.from({ length: 100 }, (_, i) =>
      makeBox(`box-${String(i).padStart(3, '0')}`, [10, 20, 30], '#c8553d', 'layer-default'),
    );
    const result = groupEntitiesForInstancing(entities);
    expect(result.size).toBe(1);
    const [batch] = result.values();
    expect(batch).toBeDefined();
    expect(batch!.entities).toHaveLength(100);
  });

  it('all cylinders with the same params → 1 batch', () => {
    const entities: Entity[] = [
      makeCylinder('c1', 5, 12),
      makeCylinder('c2', 5, 12),
      makeCylinder('c3', 5, 12),
    ];
    const result = groupEntitiesForInstancing(entities);
    expect(result.size).toBe(1);
    const [batch] = result.values();
    expect(batch!.entities).toHaveLength(3);
  });
});

describe('groupEntitiesForInstancing — mixed batchable and non-batchable', () => {
  it('omits non-batchable entities (cone) from the result', () => {
    const entities: Entity[] = [
      makeBox('b1', [10, 20, 30]),
      makeConeStub('cone-1'),
      makeBox('b2', [10, 20, 30]),
    ];
    const result = groupEntitiesForInstancing(entities);
    // Only the two identical boxes form one batch; the cone is omitted.
    expect(result.size).toBe(1);
    const [batch] = result.values();
    expect(batch!.entities).toHaveLength(2);
    expect(batch!.entities.some((e) => e.id === 'cone-1')).toBe(false);
  });

  it('handles a mix of batchable kinds and unique params', () => {
    const entities: Entity[] = [
      makeBox('b1', [10, 20, 30], '#ff0000'), // key A
      makeBox('b2', [10, 20, 30], '#ff0000'), // key A (same batch)
      makeBox('b3', [5, 5, 5], '#ff0000'),    // key B (different size)
      makeSphere('s1', 7),                    // key C
      makeConeStub('cone-1'),                 // non-batchable → omitted
    ];
    const result = groupEntitiesForInstancing(entities);
    expect(result.size).toBe(3); // key A, key B, key C
    const batchA = Array.from(result.values()).find((b) => b.entities.length === 2);
    expect(batchA).toBeDefined();
    expect(batchA!.entities.map((e) => e.id)).toContain('b1');
    expect(batchA!.entities.map((e) => e.id)).toContain('b2');
  });
});

describe('groupEntitiesForInstancing — sort determinism', () => {
  it('entities within a batch are sorted by id (lexicographic ascending)', () => {
    // Deliberately insert in non-alphabetical order.
    const entities: Entity[] = [
      makeBox('box-c', [10, 20, 30]),
      makeBox('box-a', [10, 20, 30]),
      makeBox('box-b', [10, 20, 30]),
    ];
    const result = groupEntitiesForInstancing(entities);
    expect(result.size).toBe(1);
    const [batch] = result.values();
    const ids = batch!.entities.map((e) => e.id);
    expect(ids).toEqual(['box-a', 'box-b', 'box-c']);
  });

  it('different input orderings produce the same sorted batch', () => {
    const make = (): Entity[] => [
      makeBox('z-entity', [1, 2, 3]),
      makeBox('a-entity', [1, 2, 3]),
      makeBox('m-entity', [1, 2, 3]),
    ];

    const r1 = groupEntitiesForInstancing(make());
    const r2 = groupEntitiesForInstancing(make().reverse());

    const ids1 = Array.from(r1.values())[0]!.entities.map((e) => e.id);
    const ids2 = Array.from(r2.values())[0]!.entities.map((e) => e.id);
    expect(ids1).toEqual(ids2);
  });

  it('100 unique-id entities → stable index ordering', () => {
    const entities: Entity[] = Array.from({ length: 100 }, (_, i) =>
      makeBox(`id-${String(100 - i).padStart(3, '0')}`, [2, 4, 6]), // descending order
    );
    const result = groupEntitiesForInstancing(entities);
    const [batch] = result.values();
    const ids = batch!.entities.map((e) => e.id);
    // Should be ascending lexicographic order after sort.
    const sorted = [...ids].sort();
    expect(ids).toEqual(sorted);
  });
});

// ---------------------------------------------------------------------------
// entityIdFromInstanceId
// ---------------------------------------------------------------------------

describe('entityIdFromInstanceId', () => {
  const batch = {
    key: 'box|10|20|30|#ff0000|layer-default',
    kind: 'box' as const,
    entities: [
      makeBox('alpha', [10, 20, 30]),
      makeBox('beta', [10, 20, 30]),
      makeBox('gamma', [10, 20, 30]),
    ],
  };

  it('maps instanceId 0 → first entity id', () => {
    expect(entityIdFromInstanceId(batch, 0)).toBe('alpha');
  });

  it('maps instanceId 1 → second entity id', () => {
    expect(entityIdFromInstanceId(batch, 1)).toBe('beta');
  });

  it('maps instanceId 2 → third entity id', () => {
    expect(entityIdFromInstanceId(batch, 2)).toBe('gamma');
  });

  it('returns undefined for out-of-range instanceId', () => {
    expect(entityIdFromInstanceId(batch, 99)).toBeUndefined();
  });

  it('returns undefined for negative instanceId', () => {
    expect(entityIdFromInstanceId(batch, -1)).toBeUndefined();
  });

  it('single-entity batch: instanceId 0 → the one entity', () => {
    const single = {
      key: 'sphere|7|#ff0000|layer-default',
      kind: 'sphere' as const,
      entities: [makeSphere('only-one')],
    };
    expect(entityIdFromInstanceId(single, 0)).toBe('only-one');
  });
});

// ---------------------------------------------------------------------------
// 100 unique-color entities → 100 batches (1 instance each)
// ---------------------------------------------------------------------------

describe('groupEntitiesForInstancing — 100 unique-color boxes', () => {
  it('produces 100 batches each with exactly 1 entity', () => {
    const entities: Entity[] = Array.from({ length: 100 }, (_, i) =>
      makeBox(`box-${i}`, [5, 5, 5], `#${String(i).padStart(6, '0')}`),
    );
    const result = groupEntitiesForInstancing(entities);
    expect(result.size).toBe(100);
    for (const batch of result.values()) {
      expect(batch.entities).toHaveLength(1);
    }
  });
});
