/**
 * Unit tests for describe_scene + computeSceneSnapshot (read-only scene snapshot).
 *
 * Pure: a document is built with createEmptyDocument(); ids reset between tests.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import type { Entity } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { computeSceneSnapshot, entityBounds, worldAabb } from '@core/commands/scene';
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
// W4F — worldAabb: rotation-aware world AABB
// ---------------------------------------------------------------------------

describe('worldAabb — fast path (no rotation)', () => {
  beforeEach(() => __resetIdCounter());

  it('returns entityBounds unchanged for zero rotation', () => {
    const e: Entity = {
      id: 'b1', kind: 'box', size: [4, 6, 8],
      position: [1, 2, 3], rotation: [0, 0, 0], layerId: 'layer-default', color: '#fff',
    };
    expect(worldAabb(e)).toEqual(entityBounds(e));
  });

  it('returns entityBounds unchanged when rotation field is absent', () => {
    // Cast: rotation is required in types but absent callers may slip through at runtime.
    const e = {
      id: 'b2', kind: 'box', size: [2, 2, 2],
      position: [0, 0, 0], rotation: undefined as unknown as [number,number,number],
      layerId: 'layer-default', color: '#fff',
    } as Entity;
    expect(worldAabb(e)).toEqual(entityBounds(e));
  });
});

describe('worldAabb — rotated box swaps footprint', () => {
  beforeEach(() => __resetIdCounter());

  it('2×4×6 box rotated 90° about Z: X-extent becomes 4, Y-extent becomes 2', () => {
    // Box centered at origin: local AABB min=[-1,-2,-3], max=[1,2,3]
    // After Rz=π/2: local X→−Y, local Y→X
    // So world X-extent = 4 (was local Y), world Y-extent = 2 (was local X)
    const e: Entity = {
      id: 'b3', kind: 'box', size: [2, 4, 6],
      position: [0, 0, 0], rotation: [0, 0, Math.PI / 2], layerId: 'layer-default', color: '#fff',
    };
    const b = worldAabb(e);
    expect(b.min[0]).toBeCloseTo(-2, 5);
    expect(b.max[0]).toBeCloseTo(2, 5);
    expect(b.min[1]).toBeCloseTo(-1, 5);
    expect(b.max[1]).toBeCloseTo(1, 5);
    // Z unchanged
    expect(b.min[2]).toBeCloseTo(-3, 5);
    expect(b.max[2]).toBeCloseTo(3, 5);
  });

  it('2×4×6 box rotated 45° about Z: world AABB is larger than local AABB', () => {
    // Local half-extents in X/Y: 1 and 2. At 45° the diagonal is the max extent:
    // max(|x·cos45 - y·sin45|) for corners (±1, ±2) = (1+2)/√2 ≈ 2.121
    const e: Entity = {
      id: 'b4', kind: 'box', size: [2, 4, 6],
      position: [0, 0, 0], rotation: [0, 0, Math.PI / 4], layerId: 'layer-default', color: '#fff',
    };
    const b = worldAabb(e);
    const localB = entityBounds(e);
    // World AABB X half-extent should exceed local X half-extent (1)
    expect(b.max[0]).toBeGreaterThan(localB.max[0]);
    // World AABB Y half-extent should exceed local Y half-extent (2)
    expect(b.max[1]).toBeGreaterThan(localB.max[1]);
    // Diagonal extent: (hx+hy)/√2 = (1+2)/√2 ≈ 2.121
    expect(b.max[0]).toBeCloseTo((1 + 2) / Math.SQRT2, 5);
    expect(b.max[1]).toBeCloseTo((1 + 2) / Math.SQRT2, 5);
  });

  it('cone (asymmetric local AABB) rotated 90° about X pivots about position, not the AABB center', () => {
    // Cone local AABB: min=[-2,-2,0], max=[2,2,6] (base at z=0, apex at z=6); position=[0,0,0].
    // Rx=π/2 maps (x,y,z)→(x,−z,y) about the origin. The pivot is position [0,0,0], NOT the
    // AABB centroid [0,0,3] — so world Y spans [−6, 0] (from local z∈[0,6]), which a
    // centroid-pivot bug would instead report as [−3, 3].
    const e: Entity = {
      id: 'cn1', kind: 'cone', radius: 2, height: 6,
      position: [0, 0, 0], rotation: [Math.PI / 2, 0, 0], layerId: 'layer-default', color: '#fff',
    };
    const b = worldAabb(e);
    expect(b.min[0]).toBeCloseTo(-2, 5);
    expect(b.max[0]).toBeCloseTo(2, 5);
    expect(b.min[1]).toBeCloseTo(-6, 5);
    expect(b.max[1]).toBeCloseTo(0, 5);
    expect(b.min[2]).toBeCloseTo(-2, 5);
    expect(b.max[2]).toBeCloseTo(2, 5);
  });
});

describe('worldAabb — describe_scene uses rotation-aware bounds', () => {
  beforeEach(() => __resetIdCounter());

  it('non-rotated entity: snapshot bounds == entityBounds', () => {
    let doc = createEmptyDocument();
    doc = execute(doc, 'add_box', { size: [4, 6, 8], position: [0, 0, 0] }).document;
    const snap = computeSceneSnapshot(doc);
    const id = doc.order[0]!;
    expect(snap.entities[0]!.bounds).toEqual(entityBounds(doc.entities[id]!));
    expect(snap.entities[0]!.rotated).toBeUndefined();
  });

  it('rotated entity: snapshot bounds reflects the world AABB and rotated flag is set', () => {
    const e: Entity = {
      id: 'rx1', kind: 'box', size: [2, 4, 6],
      position: [0, 0, 0], rotation: [0, 0, Math.PI / 2], layerId: 'layer-default', color: '#fff',
    };
    const doc = {
      ...createEmptyDocument(),
      entities: { rx1: e },
      order: ['rx1'],
    };
    const snap = computeSceneSnapshot(doc);
    const b = snap.entities[0]!.bounds;
    // X-extent ≈ 4 (swapped from local Y)
    expect(b.max[0]).toBeCloseTo(2, 5);
    expect(b.max[1]).toBeCloseTo(1, 5);
    expect(snap.entities[0]!.rotated).toBe(true);
  });

  it('scene overall bounds includes the rotation-aware entity footprint', () => {
    // A box at origin rotated 90° about Z: size [2,4,6] → world X-extent=4, Y-extent=2
    const e: Entity = {
      id: 'rx2', kind: 'box', size: [2, 4, 6],
      position: [0, 0, 0], rotation: [0, 0, Math.PI / 2], layerId: 'layer-default', color: '#fff',
    };
    const doc = { ...createEmptyDocument(), entities: { rx2: e }, order: ['rx2'] };
    const snap = computeSceneSnapshot(doc);
    expect(snap.bounds!.max[0]).toBeCloseTo(2, 5);
    expect(snap.bounds!.max[1]).toBeCloseTo(1, 5);
  });
});

describe('W4F — add_box creation summary reports rotation-aware world AABB', () => {
  beforeEach(() => __resetIdCounter());

  it('unrotated box: summary world AABB matches entityBounds', () => {
    const result = execute(createEmptyDocument(), 'add_box', { size: [2, 4, 6] });
    // Exact boundsText for a centered 2×4×6 box at origin (tighter than substring matches).
    expect(result.summary).toContain('world AABB min [-1, -2, -3] max [1, 2, 3]');
  });

  it('rotated box (Rz=π/4): summary reports expanded world AABB, not the unrotated local AABB', () => {
    const result = execute(createEmptyDocument(), 'add_box', {
      size: [2, 4, 6],
      rotation: [0, 0, Math.PI / 4],
    });
    expect(result.summary).toContain('world AABB');
    // The local X max is 1; after 45° rotation the world X max ≈ 2.121 — not "1"
    // Check the summary does NOT contain the local max "1, " as the X bound
    // (we verify it contains a value > 1, concretely ≈2.121)
    const id = result.affected[0]!;
    const e = result.document.entities[id]!;
    const wb = worldAabb(e);
    const fmt = (v: number): string => parseFloat(v.toFixed(4)).toString();
    expect(result.summary).toContain(fmt(wb.max[0]));
  });
});
