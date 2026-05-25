/**
 * Unit tests for describe_scene + computeSceneSnapshot (read-only scene snapshot).
 *
 * Pure: a document is built with createEmptyDocument(); ids reset between tests.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import type { Entity } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { computeSceneSnapshot, entityBounds } from '@core/commands/scene';
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
