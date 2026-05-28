/**
 * Unit tests for describe_scene + computeSceneSnapshot (read-only scene snapshot).
 *
 * Pure: a document is built with createEmptyDocument(); ids reset between tests.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import type { Entity } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { computeSceneSnapshot, entityBounds, rotatedEntityBounds, instanceBoundsFromDoc } from '@core/commands/scene';
import { __resetIdCounter } from '@lib/id';

describe('describe_scene command', () => {
  beforeEach(() => __resetIdCounter());

  it('returns a snapshot in data and leaves the document unchanged', () => {
    let doc = createEmptyDocument();
    doc = execute(doc, 'add_box', { size: [2, 2, 2] }).document;
    const before = JSON.stringify(doc);

    const result = execute(doc, 'describe_scene', {});

    expect(result.affected).toHaveLength(0);
    expect(result.document).toBe(doc);
    expect(JSON.stringify(doc)).toBe(before);
    const data = result.data as ReturnType<typeof computeSceneSnapshot>;
    expect(data.entityCount).toBe(1);
    expect(data.entities[0]!.kind).toBe('box');
  });

  it('summary uses singular vs plural correctly', () => {
    const empty = execute(createEmptyDocument(), 'describe_scene', {});
    expect(empty.summary).toContain('0 entities');

    let doc = createEmptyDocument();
    doc = execute(doc, 'add_box', { size: [1, 1, 1] }).document;
    expect(execute(doc, 'describe_scene', {}).summary).toContain('1 entity');
  });

  it('reports per-layer entity counts, selection, and groups', () => {
    let doc = createEmptyDocument();
    const a = execute(doc, 'add_box', { size: [1, 1, 1] });
    doc = a.document;
    const b = execute(doc, 'add_box', { size: [1, 1, 1] });
    doc = b.document;
    doc = execute(doc, 'group_entities', { ids: [a.affected[0], b.affected[0]], name: 'Pair' }).document;
    doc = { ...doc, selection: [a.affected[0]!] };

    const snap = computeSceneSnapshot(doc);
    expect(snap.layers[0]!.entityCount).toBe(2);
    expect(snap.selection).toEqual([a.affected[0]]);
    expect(snap.groups).toHaveLength(1);
    expect(snap.groups[0]!.name).toBe('Pair');
  });
});

describe('computeSceneSnapshot — overall bounds', () => {
  beforeEach(() => __resetIdCounter());

  it('is null for an empty document', () => {
    expect(computeSceneSnapshot(createEmptyDocument()).bounds).toBeNull();
  });

  it('merges entity bounds across the scene', () => {
    let doc = createEmptyDocument();
    doc = execute(doc, 'add_box', { size: [2, 2, 2], position: [0, 0, 0] }).document;
    doc = execute(doc, 'add_box', { size: [2, 2, 2], position: [10, 0, 0] }).document;
    const snap = computeSceneSnapshot(doc);
    expect(snap.bounds!.min).toEqual([-1, -1, -1]);
    expect(snap.bounds!.max).toEqual([11, 1, 1]);
  });
});

describe('entityBounds — per kind', () => {
  beforeEach(() => __resetIdCounter());

  function lastEntity(doc: ReturnType<typeof createEmptyDocument>): Entity {
    const id = doc.order[doc.order.length - 1]!;
    return doc.entities[id]!;
  }

  it('box: position ± size/2', () => {
    const doc = execute(createEmptyDocument(), 'add_box', { size: [4, 6, 8], position: [1, 1, 1] }).document;
    expect(entityBounds(lastEntity(doc))).toEqual({ min: [-1, -2, -3], max: [3, 4, 5] });
  });

  it('cylinder: radius in X/Z, height in Y (three.js axis)', () => {
    const doc = execute(createEmptyDocument(), 'add_cylinder', { radius: 2, height: 10, position: [0, 0, 0] }).document;
    expect(entityBounds(lastEntity(doc))).toEqual({ min: [-2, -5, -2], max: [2, 5, 2] });
  });

  it('sphere: position ± radius on all axes', () => {
    const doc = execute(createEmptyDocument(), 'add_sphere', { radius: 3, position: [1, 0, 0] }).document;
    expect(entityBounds(lastEntity(doc))).toEqual({ min: [-2, -3, -3], max: [4, 3, 3] });
  });

  it('extrusion: profile XY bbox, +Z over depth', () => {
    const doc = execute(createEmptyDocument(), 'extrude_profile', {
      profile: [[0, 0], [4, 0], [4, 2], [0, 2]],
      depth: 5,
    }).document;
    expect(entityBounds(lastEntity(doc))).toEqual({ min: [0, 0, 0], max: [4, 2, 5] });
  });

  it('extrusion with empty profile collapses to its position plane', () => {
    const e: Entity = {
      id: 'ext-x', kind: 'extrusion', profile: [], depth: 3,
      position: [2, 2, 0], rotation: [0, 0, 0], layerId: 'layer-default', color: '#fff',
    };
    expect(entityBounds(e)).toEqual({ min: [2, 2, 0], max: [2, 2, 3] });
  });

  it('mesh: bounds over world-space vertex positions', () => {
    const e: Entity = {
      id: 'm1', kind: 'mesh',
      mesh: { positions: [0, 0, 0, 2, 3, 4, -1, -1, -1], indices: [0, 1, 2] },
      position: [0, 0, 0], rotation: [0, 0, 0], layerId: 'layer-default', color: '#fff',
    };
    expect(entityBounds(e)).toEqual({ min: [-1, -1, -1], max: [2, 3, 4] });
  });

  it('mesh with too few positions collapses to its position', () => {
    const e: Entity = {
      id: 'm2', kind: 'mesh', mesh: { positions: [], indices: [] },
      position: [5, 5, 5], rotation: [0, 0, 0], layerId: 'layer-default', color: '#fff',
    };
    expect(entityBounds(e)).toEqual({ min: [5, 5, 5], max: [5, 5, 5] });
  });

  it('line: bbox of endpoints offset by position', () => {
    const doc = execute(createEmptyDocument(), 'draw_line', { start: [1, 1], end: [4, 5], position: [1, 0, 0] }).document;
    expect(entityBounds(lastEntity(doc))).toEqual({ min: [2, 1, 0], max: [5, 5, 0] });
  });

  it('polyline: bbox over all points', () => {
    const doc = execute(createEmptyDocument(), 'draw_polyline', { points: [[0, 0], [3, 1], [1, 4]] }).document;
    expect(entityBounds(lastEntity(doc))).toEqual({ min: [0, 0, 0], max: [3, 4, 0] });
  });

  it('polyline with no points collapses to its position', () => {
    const e: Entity = {
      id: 'pl', kind: 'polyline', points: [], closed: false,
      position: [7, 8, 9], rotation: [0, 0, 0], layerId: 'layer-default', color: '#fff',
    };
    expect(entityBounds(e)).toEqual({ min: [7, 8, 9], max: [7, 8, 9] });
  });

  it('circle: center ± radius', () => {
    const doc = execute(createEmptyDocument(), 'draw_circle', { center: [2, 2], radius: 3 }).document;
    expect(entityBounds(lastEntity(doc))).toEqual({ min: [-1, -1, 0], max: [5, 5, 0] });
  });

  it('arc: conservative center ± radius box', () => {
    const doc = execute(createEmptyDocument(), 'draw_arc', {
      center: [0, 0], radius: 2, startAngle: 0, endAngle: Math.PI / 2,
    }).document;
    expect(entityBounds(lastEntity(doc))).toEqual({ min: [-2, -2, 0], max: [2, 2, 0] });
  });

  it('rectangle: lower-left at position, extends +X/+Y', () => {
    const doc = execute(createEmptyDocument(), 'draw_rectangle', { width: 4, height: 2, position: [1, 1, 0] }).document;
    expect(entityBounds(lastEntity(doc))).toEqual({ min: [1, 1, 0], max: [5, 3, 0] });
  });

  it('point: zero-extent at position', () => {
    const doc = execute(createEmptyDocument(), 'draw_point', { position: [3, 4, 5] }).document;
    expect(entityBounds(lastEntity(doc))).toEqual({ min: [3, 4, 5], max: [3, 4, 5] });
  });
});

// ---------------------------------------------------------------------------
// rotatedEntityBounds — OBB-aware world-space AABB
// ---------------------------------------------------------------------------

describe('rotatedEntityBounds — zero rotation is byte-for-byte identical to entityBounds', () => {
  beforeEach(() => __resetIdCounter());

  it('box with zero rotation: no oriented flag, same values as entityBounds', () => {
    const doc = execute(createEmptyDocument(), 'add_box', { size: [4, 6, 8], position: [1, 1, 1] }).document;
    const e = doc.entities[doc.order[0]!]!;
    const plain = entityBounds(e);
    const obb = rotatedEntityBounds(e);
    expect(obb).toEqual(plain);
    expect(obb.oriented).toBeUndefined();
  });

  it('cylinder with zero rotation: no oriented flag, same values as entityBounds', () => {
    const doc = execute(createEmptyDocument(), 'add_cylinder', { radius: 2, height: 10, position: [0, 0, 0] }).document;
    const e = doc.entities[doc.order[0]!]!;
    expect(rotatedEntityBounds(e)).toEqual(entityBounds(e));
    expect(rotatedEntityBounds(e).oriented).toBeUndefined();
  });
});

describe('rotatedEntityBounds — non-zero rotation produces oriented:true and correct extents', () => {
  beforeEach(() => __resetIdCounter());

  const EPS = 1e-9;
  function approxEq(a: number, b: number): boolean { return Math.abs(a - b) < EPS; }

  it('box [2,2,10] rotated [π/2,0,0]: tall Z-axis box becomes tall Y-axis box', () => {
    // Unrotated: extends ±1 in X/Y, ±5 in Z.
    // After Rx(π/2): Z-axis maps to +Y, so extents become ±1 in X/Z, ±5 in Y.
    let doc = createEmptyDocument();
    doc = execute(doc, 'add_box', { size: [2, 2, 10], position: [0, 0, 0] }).document;
    const id = doc.order[0]!;
    doc = execute(doc, 'rotate_entity', { id, delta: [Math.PI / 2, 0, 0] }).document;
    const e = doc.entities[id]!;
    const b = rotatedEntityBounds(e);

    expect(b.oriented).toBe(true);
    // X extents: ±1
    expect(approxEq(b.min[0], -1)).toBe(true);
    expect(approxEq(b.max[0],  1)).toBe(true);
    // After Rx(π/2): old ±5 Z → ±5 Y
    expect(approxEq(b.min[1], -5)).toBe(true);
    expect(approxEq(b.max[1],  5)).toBe(true);
    // After Rx(π/2): old ±1 Y → ∓1 Z (sign depends on rotation direction) → extent still 2
    expect(Math.abs(b.max[2] - b.min[2])).toBeGreaterThan(1.9);
    expect(Math.abs(b.max[2] - b.min[2])).toBeLessThan(2.1);
  });

  it('rotated box: AABB is strictly larger than unrotated box in X and Y', () => {
    // A box [4,2,2] (plainXExtent=4, plainYExtent=2) rotated 45° about Z:
    //   OBB X extent = 4*cos45 + 2*sin45 = 3√2 ≈ 4.243  (> 4)
    //   OBB Y extent = 4*sin45 + 2*cos45 = 3√2 ≈ 4.243  (> 2)
    // Both axes grow — the OBB AABB is larger than the unrotated AABB on both X and Y.
    let doc = createEmptyDocument();
    doc = execute(doc, 'add_box', { size: [4, 2, 2], position: [0, 0, 0] }).document;
    const id = doc.order[0]!;
    doc = execute(doc, 'rotate_entity', { id, delta: [0, 0, Math.PI / 4] }).document;
    const e = doc.entities[id]!;
    const obb = rotatedEntityBounds(e);
    const plain = entityBounds({ ...e, rotation: [0, 0, 0] });

    expect(obb.oriented).toBe(true);
    const obbXExtent = obb.max[0] - obb.min[0];
    const obbYExtent = obb.max[1] - obb.min[1];
    const plainXExtent = plain.max[0] - plain.min[0];
    const plainYExtent = plain.max[1] - plain.min[1];
    // OBB extents must be strictly larger than unrotated extents (both axes grow at 45°).
    expect(obbXExtent).toBeGreaterThan(plainXExtent - EPS);
    expect(obbYExtent).toBeGreaterThan(plainYExtent - EPS);
    // Z extent unchanged (Rz does not affect Z).
    expect(approxEq(obb.max[2] - obb.min[2], plain.max[2] - plain.min[2])).toBe(true);
  });

  it('rotated box differs from naive unrotated AABB', () => {
    // This is the regression test: naive AABB (pre-fix) would ignore rotation.
    let doc = createEmptyDocument();
    doc = execute(doc, 'add_box', { size: [1, 1, 10], position: [0, 0, 0] }).document;
    const id = doc.order[0]!;
    doc = execute(doc, 'rotate_entity', { id, delta: [Math.PI / 2, 0, 0] }).document;
    const e = doc.entities[id]!;
    const obb = rotatedEntityBounds(e);
    const naive = entityBounds(e); // entityBounds ignores rotation

    // Naive: max[2]=5 (tall Z). OBB after Rx(π/2): max[2]≈0.5 (only 1-unit in Z).
    expect(obb.max[2]).toBeLessThan(naive.max[2] - 1);
  });

  it('describe_scene data carries oriented:true for a rotated entity', () => {
    let doc = createEmptyDocument();
    doc = execute(doc, 'add_box', { size: [1, 1, 4], position: [0, 0, 0] }).document;
    const id = doc.order[0]!;
    doc = execute(doc, 'rotate_entity', { id, delta: [Math.PI / 4, 0, 0] }).document;

    const result = execute(doc, 'describe_scene', {});
    const snap = result.data as ReturnType<typeof computeSceneSnapshot>;
    expect(snap.entities[0]!.bounds.oriented).toBe(true);
  });

  it('describe_scene data has no oriented flag for an unrotated entity', () => {
    let doc = createEmptyDocument();
    doc = execute(doc, 'add_box', { size: [2, 2, 2], position: [0, 0, 0] }).document;

    const result = execute(doc, 'describe_scene', {});
    const snap = result.data as ReturnType<typeof computeSceneSnapshot>;
    expect(snap.entities[0]!.bounds.oriented).toBeUndefined();
  });

  it('cylinder rotated [π/2,0,0]: Z-axis cylinder becomes X-axis cylinder, extents swap', () => {
    // Unrotated cylinder (Y-axis in three.js): extent ±radius in X/Z, ±height/2 in Y.
    // After Rx(π/2): Y-axis maps to -Z, Z-axis maps to +Y.
    // So the tall Y extent (height/2=5) maps to Z, and the flat Z extent (radius=2) maps to Y.
    let doc = createEmptyDocument();
    doc = execute(doc, 'add_cylinder', { radius: 2, height: 10, position: [0, 0, 0] }).document;
    const id = doc.order[0]!;
    doc = execute(doc, 'rotate_entity', { id, delta: [Math.PI / 2, 0, 0] }).document;
    const e = doc.entities[id]!;
    const b = rotatedEntityBounds(e);

    expect(b.oriented).toBe(true);
    // X extents still ±2 (X axis unaffected by Rx).
    expect(approxEq(b.min[0], -2)).toBe(true);
    expect(approxEq(b.max[0],  2)).toBe(true);
    // Y extent: was ±5, now maps to ±5 in Z; Y gets ±2 from old Z corners.
    const yExtent = b.max[1] - b.min[1];
    const zExtent = b.max[2] - b.min[2];
    expect(yExtent).toBeLessThan(zExtent); // Y (radius) < Z (height) after rotation
  });

  it('rotated mesh with non-zero position stays consistent with the raw (unrotated) path', () => {
    // Mesh vertices are WORLD-space; entityBounds returns them raw (NOT offset by position).
    // A 2×2×2 vertex box centered exactly at position [4,0,0], rotated 180° about Z about its
    // own origin, maps onto itself → bounds must equal the raw AABB. Before the localEntityCorners
    // mesh fix (which double-added position) the bounds would be shifted by R·position and wrong.
    const e: Entity = {
      id: 'mrot', kind: 'mesh',
      mesh: {
        positions: [
          3, -1, -1, 5, -1, -1, 5, 1, -1, 3, 1, -1,
          3, -1, 1, 5, -1, 1, 5, 1, 1, 3, 1, 1,
        ],
        indices: [0, 1, 2],
      },
      position: [4, 0, 0], rotation: [0, 0, Math.PI], layerId: 'layer-default', color: '#fff',
    };
    const b = rotatedEntityBounds(e);
    expect(b.oriented).toBe(true);
    expect(approxEq(b.min[0], 3)).toBe(true);
    expect(approxEq(b.max[0], 5)).toBe(true);
    expect(approxEq(b.min[1], -1)).toBe(true);
    expect(approxEq(b.max[1], 1)).toBe(true);
    expect(approxEq(b.min[2], -1)).toBe(true);
    expect(approxEq(b.max[2], 1)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// instanceBoundsFromDoc — NF1 assembly bounds
// ---------------------------------------------------------------------------

describe('instanceBoundsFromDoc — instance world AABB', () => {
  beforeEach(() => __resetIdCounter());

  it('happy path: instance bounds reflect the component child geometry', () => {
    // create_component promotes entities and inserts one instance
    let doc = createEmptyDocument();
    doc = execute(doc, 'add_box', { size: [2, 2, 2], position: [0, 0, 0] }).document;
    const boxId = doc.order[0]!;
    const createResult = execute(doc, 'create_component', { entityIds: [boxId], name: 'MyBox' });
    doc = createResult.document;

    // There should be exactly one instance entity
    const instanceId = doc.order[0]!;
    const instance = doc.entities[instanceId]!;
    expect(instance.kind).toBe('instance');

    // instanceBoundsFromDoc must return the expanded box AABB, NOT a point
    const bounds = instanceBoundsFromDoc(instance as Parameters<typeof instanceBoundsFromDoc>[0], doc);
    // A 2×2×2 box centered at [0,0,0] → min [-1,-1,-1] max [1,1,1]
    expect(bounds.min[0]).toBeCloseTo(-1, 5);
    expect(bounds.min[1]).toBeCloseTo(-1, 5);
    expect(bounds.min[2]).toBeCloseTo(-1, 5);
    expect(bounds.max[0]).toBeCloseTo(1, 5);
    expect(bounds.max[1]).toBeCloseTo(1, 5);
    expect(bounds.max[2]).toBeCloseTo(1, 5);
  });

  it('describe_scene reports instance AABB via expanded component, not a degenerate point', () => {
    let doc = createEmptyDocument();
    doc = execute(doc, 'add_box', { size: [4, 4, 4], position: [10, 0, 0] }).document;
    const boxId = doc.order[0]!;
    doc = execute(doc, 'create_component', { entityIds: [boxId], name: 'BigBox' }).document;

    const snap = computeSceneSnapshot(doc);
    expect(snap.entityCount).toBe(1);
    const eb = snap.entities[0]!.bounds;
    // A 4×4×4 box centred at [10,0,0] → min [8,-2,-2] max [12,2,2]
    // The AABB must be non-degenerate (min ≠ max) — not just a point at instance.position
    const xExtent = eb.max[0] - eb.min[0];
    expect(xExtent).toBeGreaterThan(3);
  });

  it('failure path: missing component → degenerate point at instance position', () => {
    const doc = createEmptyDocument();
    // Synthesise an instance referencing a non-existent component
    const fakeInstance: Entity = {
      id: 'inst-fake',
      kind: 'instance',
      componentId: 'comp-missing',
      position: [5, 5, 5],
      rotation: [0, 0, 0],
      layerId: 'layer-default',
      color: '#fff',
    };
    const bounds = instanceBoundsFromDoc(
      fakeInstance as Parameters<typeof instanceBoundsFromDoc>[0],
      doc,
    );
    expect(bounds.min).toEqual([5, 5, 5]);
    expect(bounds.max).toEqual([5, 5, 5]);
  });

  it('entityBounds for instance kind returns a point at the instance position (doc-less fallback)', () => {
    const fakeInstance: Entity = {
      id: 'inst-pt',
      kind: 'instance',
      componentId: 'comp-x',
      position: [3, 7, 2],
      rotation: [0, 0, 0],
      layerId: 'layer-default',
      color: '#fff',
    };
    const b = entityBounds(fakeInstance);
    expect(b.min).toEqual([3, 7, 2]);
    expect(b.max).toEqual([3, 7, 2]);
  });
});
