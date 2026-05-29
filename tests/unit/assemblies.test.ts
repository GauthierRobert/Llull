/**
 * Assembly command tests: create_component, insert_instance, explode_instance,
 * scale_entity on instances, instance bounds from describe_scene.
 *
 * Also covers the B1 regression: rotated-entity summaries use the world AABB
 * (rotatedEntityBounds), so a π/4 box reports expanded extents.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import type { InstanceEntity } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { rotatedEntityBounds } from '@core/commands/scene';
import { expandInstance } from '@core/commands/assemblies';
import { __resetIdCounter } from '@lib/id';
import type { Component } from '@core/model/types';

describe('assemblies', () => {
  beforeEach(() => __resetIdCounter());

  // ---------------------------------------------------------------------------
  // B1 regression — rotated-entity summary AABB is expanded vs. unrotated
  // ---------------------------------------------------------------------------

  it('add_box summary AABB is expanded when rotation is applied (B1 regression)', () => {
    const doc = createEmptyDocument();

    // Unrotated 2×4×2 box: AABB extents are exactly [±1, ±2, ±1].
    const unrotated = execute(doc, 'add_box', { size: [2, 4, 2], position: [0, 0, 0] });
    const unrotatedId = unrotated.affected[0]!;
    const unrotatedEntity = unrotated.document.entities[unrotatedId]!;
    const unrotatedBounds = rotatedEntityBounds(unrotatedEntity);
    const unrotatedSpanX = unrotatedBounds.max[0] - unrotatedBounds.min[0];
    const unrotatedSpanY = unrotatedBounds.max[1] - unrotatedBounds.min[1];

    // Rotated π/4 about Z: the AABB must be wider in X and Y than the unrotated case.
    const rotated = execute(doc, 'add_box', {
      size: [2, 4, 2],
      position: [0, 0, 0],
      rotation: [0, 0, Math.PI / 4],
    });
    const rotatedId = rotated.affected[0]!;
    const rotatedEntity = rotated.document.entities[rotatedId]!;
    const rotatedBounds = rotatedEntityBounds(rotatedEntity);
    const rotatedSpanX = rotatedBounds.max[0] - rotatedBounds.min[0];
    const rotatedSpanY = rotatedBounds.max[1] - rotatedBounds.min[1];

    // The rotated box has a larger world AABB footprint.
    expect(rotatedSpanX).toBeGreaterThan(unrotatedSpanX);
    expect(rotatedSpanY).toBeGreaterThan(unrotatedSpanY);

    // The summary string must contain the AABB text (not just size).
    expect(rotated.summary).toContain('world AABB');

    // Verify the summary AABB reflects the rotated extents (not the unrotated ones).
    // For a 2×4×2 box rotated π/4 the diagonal in XY ≈ √(1²+2²)*√2 ≈ 3.16, so span > 2.
    expect(rotatedSpanX).toBeGreaterThan(2);
    expect(rotatedSpanY).toBeGreaterThan(4);
  });

  it('add_cylinder summary AABB is expanded when rotation is applied (B1 regression)', () => {
    const doc = createEmptyDocument();
    // Cylinder r=1, h=6 rotated π/2 about X: height axis tips from Y into Z.
    const result = execute(doc, 'add_cylinder', {
      radius: 1,
      height: 6,
      position: [0, 0, 0],
      rotation: [Math.PI / 2, 0, 0],
    });
    const entity = result.document.entities[result.affected[0]!]!;
    const bounds = rotatedEntityBounds(entity);
    // After rotating 90° about X the height (6) ends up in the Z extent;
    // unrotated the Z extent would be ±1 (radius). Check span > 2.
    const spanZ = bounds.max[2] - bounds.min[2];
    expect(spanZ).toBeGreaterThan(2);
    expect(result.summary).toContain('world AABB');
  });

  // ---------------------------------------------------------------------------
  // create_component
  // ---------------------------------------------------------------------------

  it('create_component promotes entities into a component and replaces them with one instance', () => {
    let doc = createEmptyDocument();
    const r1 = execute(doc, 'add_box', { size: [1, 1, 1], position: [0, 0, 0] });
    doc = r1.document;
    const r2 = execute(doc, 'add_sphere', { radius: 1, position: [5, 0, 0] });
    doc = r2.document;
    const boxId = r1.affected[0]!;
    const sphereId = r2.affected[0]!;

    const result = execute(doc, 'create_component', { name: 'MyComp', entityIds: [boxId, sphereId] });
    doc = result.document;

    // One instance replaces the two source entities.
    expect(result.affected).toHaveLength(1);
    const instanceId = result.affected[0]!;
    const instance = doc.entities[instanceId];
    expect(instance).toBeDefined();
    expect(instance!.kind).toBe('instance');

    // Source entities removed.
    expect(doc.entities[boxId]).toBeUndefined();
    expect(doc.entities[sphereId]).toBeUndefined();
    expect(doc.order).not.toContain(boxId);
    expect(doc.order).not.toContain(sphereId);
    expect(doc.order).toContain(instanceId);

    // Component stored.
    const componentId = (instance as InstanceEntity).componentId;
    expect(doc.components[componentId]).toBeDefined();
    expect(doc.components[componentId]!.name).toBe('MyComp');
    expect(Object.keys(doc.components[componentId]!.entities)).toHaveLength(2);

    // Summary is informative.
    expect(result.summary).toContain('MyComp');
    expect(result.summary).toContain(instanceId);
  });

  it('create_component is pure — input document is not mutated', () => {
    let doc = createEmptyDocument();
    doc = execute(doc, 'add_box', { size: [1, 1, 1] }).document;
    const boxId = doc.order[0]!;

    const snapshot = JSON.stringify(doc);
    execute(doc, 'create_component', { name: 'Test', entityIds: [boxId] });
    expect(JSON.stringify(doc)).toBe(snapshot);
  });

  it('create_component with empty entityIds is a graceful no-op', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'create_component', { name: 'Empty', entityIds: [] });
    expect(result.affected).toHaveLength(0);
    expect(result.document).toBe(doc);
    expect(result.summary).toContain('non-empty');
  });

  it('create_component with a missing entity id is a graceful no-op', () => {
    let doc = createEmptyDocument();
    doc = execute(doc, 'add_box', { size: [1, 1, 1] }).document;

    const result = execute(doc, 'create_component', { name: 'Bad', entityIds: ['does-not-exist'] });
    expect(result.affected).toHaveLength(0);
    expect(result.document).toBe(doc);
    expect(result.summary).toContain('does-not-exist');
  });

  it('create_component prunes removed ids from groups and selection', () => {
    let doc = createEmptyDocument();
    const r1 = execute(doc, 'add_box', { size: [1, 1, 1] });
    doc = r1.document;
    const r2 = execute(doc, 'add_box', { size: [1, 1, 1] });
    doc = r2.document;
    const idA = r1.affected[0]!;
    const idB = r2.affected[0]!;

    // Group the two.
    const grouped = execute(doc, 'group_entities', { ids: [idA, idB] });
    doc = { ...grouped.document, selection: [idA, idB] };

    // Promote both into a component.
    const result = execute(doc, 'create_component', { name: 'Pruned', entityIds: [idA, idB] });
    doc = result.document;

    // Group should be dissolved (< 2 members left).
    expect(Object.keys(doc.groups)).toHaveLength(0);
    // Selection should be clear of removed ids.
    expect(doc.selection).not.toContain(idA);
    expect(doc.selection).not.toContain(idB);
  });

  // ---------------------------------------------------------------------------
  // insert_instance
  // ---------------------------------------------------------------------------

  it('insert_instance adds an instance entity with correct transform', () => {
    let doc = createEmptyDocument();
    const r1 = execute(doc, 'add_box', { size: [1, 1, 1] });
    doc = r1.document;
    const boxId = r1.affected[0]!;

    const comp = execute(doc, 'create_component', { name: 'Widget', entityIds: [boxId] });
    doc = comp.document;
    const instanceId = comp.affected[0]!;
    const componentId = (doc.entities[instanceId] as InstanceEntity).componentId;

    const result = execute(doc, 'insert_instance', {
      componentId,
      position: [10, 0, 0],
      rotation: [0, 0, 0],
      scale: [2, 2, 2],
    });
    doc = result.document;

    expect(result.affected).toHaveLength(1);
    const newInstanceId = result.affected[0]!;
    const newInstance = doc.entities[newInstanceId]! as InstanceEntity;
    expect(newInstance.kind).toBe('instance');
    expect(newInstance.position).toEqual([10, 0, 0]);
    expect(newInstance.scale).toEqual([2, 2, 2]);
    expect(newInstance.componentId).toBe(componentId);
  });

  it('insert_instance is pure — input document is not mutated', () => {
    let doc = createEmptyDocument();
    const r1 = execute(doc, 'add_box', { size: [1, 1, 1] });
    doc = r1.document;
    const boxId = r1.affected[0]!;
    const comp = execute(doc, 'create_component', { name: 'W', entityIds: [boxId] });
    doc = comp.document;
    const instanceId = comp.affected[0]!;
    const componentId = (doc.entities[instanceId] as InstanceEntity).componentId;

    const snapshot = JSON.stringify(doc);
    execute(doc, 'insert_instance', { componentId });
    expect(JSON.stringify(doc)).toBe(snapshot);
  });

  it('insert_instance with unknown componentId is a graceful no-op', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'insert_instance', { componentId: 'ghost-comp' });
    expect(result.affected).toHaveLength(0);
    expect(result.document).toBe(doc);
    expect(result.summary).toContain('ghost-comp');
  });

  it('insert_instance with non-finite position is a graceful no-op', () => {
    let doc = createEmptyDocument();
    const r1 = execute(doc, 'add_box', { size: [1, 1, 1] });
    doc = r1.document;
    const boxId = r1.affected[0]!;
    const comp = execute(doc, 'create_component', { name: 'W2', entityIds: [boxId] });
    doc = comp.document;
    const instanceId = comp.affected[0]!;
    const componentId = (doc.entities[instanceId] as InstanceEntity).componentId;

    const result = execute(doc, 'insert_instance', {
      componentId,
      position: [Infinity, 0, 0] as unknown as [number, number, number],
    });
    expect(result.affected).toHaveLength(0);
    expect(result.document).toBe(doc);
  });

  it('two instances of one component share the same componentId (no geometry duplication)', () => {
    let doc = createEmptyDocument();
    const r1 = execute(doc, 'add_box', { size: [2, 2, 2] });
    doc = r1.document;
    const boxId = r1.affected[0]!;

    const comp = execute(doc, 'create_component', { name: 'Brick', entityIds: [boxId] });
    doc = comp.document;
    const inst1Id = comp.affected[0]!;
    const componentId = (doc.entities[inst1Id] as InstanceEntity).componentId;

    const inst2 = execute(doc, 'insert_instance', { componentId, position: [10, 0, 0] });
    doc = inst2.document;
    const inst2Id = inst2.affected[0]!;

    const i1 = doc.entities[inst1Id] as InstanceEntity;
    const i2 = doc.entities[inst2Id] as InstanceEntity;
    expect(i1.componentId).toBe(componentId);
    expect(i2.componentId).toBe(componentId);
    expect(Object.keys(doc.components)).toHaveLength(1);

    const component = doc.components[componentId]!;
    expect(Object.keys(component.entities)).toHaveLength(1);
  });

  // ---------------------------------------------------------------------------
  // explode_instance
  // ---------------------------------------------------------------------------

  it('explode_instance replaces instance with baked world-space entities', () => {
    let doc = createEmptyDocument();
    const r1 = execute(doc, 'add_box', { size: [1, 1, 1], position: [3, 0, 0] });
    doc = r1.document;
    const boxId = r1.affected[0]!;

    const comp = execute(doc, 'create_component', { name: 'BoxComp', entityIds: [boxId] });
    doc = comp.document;
    const inst1Id = comp.affected[0]!;
    const componentId = (doc.entities[inst1Id] as InstanceEntity).componentId;

    const inst2 = execute(doc, 'insert_instance', { componentId, position: [10, 0, 0] });
    doc = inst2.document;
    const inst2Id = inst2.affected[0]!;

    const result = execute(doc, 'explode_instance', { id: inst2Id });
    doc = result.document;

    // Instance gone, new concrete entities in its place.
    expect(doc.entities[inst2Id]).toBeUndefined();
    expect(result.affected).toHaveLength(1);
    const bakedId = result.affected[0]!;
    const baked = doc.entities[bakedId]!;
    expect(baked.kind).toBe('box');

    // World position: component-local box was at [3,0,0]; instance at [10,0,0] → [13,0,0].
    expect(baked.position[0]).toBeCloseTo(13);
    expect(baked.position[1]).toBeCloseTo(0);
    expect(baked.position[2]).toBeCloseTo(0);

    // Component definition is unchanged.
    expect(doc.components[componentId]).toBeDefined();
  });

  it('explode_instance bakes instance rotation and scale into child world positions', () => {
    let doc = createEmptyDocument();
    // Component-local box at [1,0,0].
    const r1 = execute(doc, 'add_box', { size: [1, 1, 1], position: [1, 0, 0] });
    doc = r1.document;
    const boxId = r1.affected[0]!;
    const comp = execute(doc, 'create_component', { name: 'Rot', entityIds: [boxId] });
    doc = comp.document;
    const componentId = (doc.entities[comp.affected[0]!] as InstanceEntity).componentId;

    // Instance: scale x2, rotate +90° about Z, translate to [0,0,5].
    const inst = execute(doc, 'insert_instance', {
      componentId,
      position: [0, 0, 5],
      rotation: [0, 0, Math.PI / 2],
      scale: [2, 2, 2],
    });
    doc = inst.document;
    const instId = inst.affected[0]!;

    const result = execute(doc, 'explode_instance', { id: instId });
    const baked = result.document.entities[result.affected[0]!]!;
    // local [1,0,0] → scale×2 → [2,0,0] → Rz(+90°) → [0,2,0] → +[0,0,5] → [0,2,5]
    expect(baked.position[0]).toBeCloseTo(0);
    expect(baked.position[1]).toBeCloseTo(2);
    expect(baked.position[2]).toBeCloseTo(5);
  });

  it('explode_instance is pure — input document is not mutated', () => {
    let doc = createEmptyDocument();
    const r1 = execute(doc, 'add_box', { size: [1, 1, 1] });
    doc = r1.document;
    const boxId = r1.affected[0]!;
    const comp = execute(doc, 'create_component', { name: 'E', entityIds: [boxId] });
    doc = comp.document;
    const instanceId = comp.affected[0]!;

    const snapshot = JSON.stringify(doc);
    execute(doc, 'explode_instance', { id: instanceId });
    expect(JSON.stringify(doc)).toBe(snapshot);
  });

  it('explode_instance on a non-instance entity is a graceful no-op', () => {
    let doc = createEmptyDocument();
    doc = execute(doc, 'add_box', { size: [1, 1, 1] }).document;
    const boxId = doc.order[0]!;

    const result = execute(doc, 'explode_instance', { id: boxId });
    expect(result.affected).toHaveLength(0);
    expect(result.document).toBe(doc);
    expect(result.summary).toContain('not an instance');
  });

  it('explode_instance on a missing id is a graceful no-op', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'explode_instance', { id: 'ghost' });
    expect(result.affected).toHaveLength(0);
    expect(result.document).toBe(doc);
  });

  it('explode_instance when component is missing is a graceful no-op', () => {
    let doc = createEmptyDocument();
    const r1 = execute(doc, 'add_box', { size: [1, 1, 1] });
    doc = r1.document;
    const boxId = r1.affected[0]!;
    const comp = execute(doc, 'create_component', { name: 'Gone', entityIds: [boxId] });
    doc = comp.document;
    const instanceId = comp.affected[0]!;

    // Manually remove the component to simulate a dangling reference.
    const danglingComponentId = (doc.entities[instanceId] as InstanceEntity).componentId;
    const remainingComponents = { ...doc.components };
    delete remainingComponents[danglingComponentId];
    doc = { ...doc, components: remainingComponents };

    const result = execute(doc, 'explode_instance', { id: instanceId });
    expect(result.affected).toHaveLength(0);
    expect(result.document).toBe(doc);
    expect(result.summary).toContain('not found');
  });

  // ---------------------------------------------------------------------------
  // describe_scene — instance bounds
  // ---------------------------------------------------------------------------

  it('describe_scene reports an instance world AABB from its component extent (not a point)', () => {
    let doc = createEmptyDocument();
    // Box size [2,2,2] at origin → local AABB [-1,-1,-1]..[1,1,1].
    const r1 = execute(doc, 'add_box', { size: [2, 2, 2], position: [0, 0, 0] });
    doc = r1.document;
    const boxId = r1.affected[0]!;
    const comp = execute(doc, 'create_component', { name: 'Brick2', entityIds: [boxId] });
    doc = comp.document;
    const componentId = (doc.entities[comp.affected[0]!] as InstanceEntity).componentId;
    // Second instance offset to [10,0,0].
    const inst2 = execute(doc, 'insert_instance', { componentId, position: [10, 0, 0] });
    doc = inst2.document;
    const inst2Id = inst2.affected[0]!;

    const snap = execute(doc, 'describe_scene', {}).data as {
      entities: Array<{ id: string; kind: string; bounds: { min: number[]; max: number[] } }>;
    };
    const summary = snap.entities.find((e) => e.id === inst2Id)!;
    expect(summary.kind).toBe('instance');
    // Component extent ±1 around the instance position → not a degenerate point.
    expect(summary.bounds.min[0]).toBeCloseTo(9);
    expect(summary.bounds.max[0]).toBeCloseTo(11);
    expect(summary.bounds.min[1]).toBeCloseTo(-1);
    expect(summary.bounds.max[1]).toBeCloseTo(1);
  });

  // ---------------------------------------------------------------------------
  // scale_entity on instances
  // ---------------------------------------------------------------------------

  it('scale_entity on an instance multiplies its scale field', () => {
    let doc = createEmptyDocument();
    const r1 = execute(doc, 'add_box', { size: [1, 1, 1] });
    doc = r1.document;
    const boxId = r1.affected[0]!;
    const comp = execute(doc, 'create_component', { name: 'S', entityIds: [boxId] });
    doc = comp.document;
    const instanceId = comp.affected[0]!;

    const scaled = execute(doc, 'scale_entity', { id: instanceId, factor: 3 });
    const instance = scaled.document.entities[instanceId] as InstanceEntity;
    expect(instance.scale).toEqual([3, 3, 3]);
  });

  // ---------------------------------------------------------------------------
  // expandInstance — deterministic id mapping (deferred-nits Item B)
  // ---------------------------------------------------------------------------

  it('expandInstance returns byte-identical ids on repeated calls (deterministic)', () => {
    // Build one instance + one component, then expand twice. The expanded
    // entity ids must match across calls — the prior implementation called
    // nextId() per expansion, so render-memo recomputes minted fresh ids
    // every frame, breaking React key stability and downstream determinism.
    let doc = createEmptyDocument();
    const box = execute(doc, 'add_box', { size: [1, 1, 1], position: [0, 0, 0] });
    doc = box.document;
    const boxId = box.affected[0]!;
    const comp = execute(doc, 'create_component', { name: 'Brick', entityIds: [boxId] });
    doc = comp.document;
    const instanceId = comp.affected[0]!;

    const instance = doc.entities[instanceId] as InstanceEntity;
    const component = doc.components[instance.componentId] as Component;

    const a = expandInstance(instance, component).map((e) => e.id);
    const b = expandInstance(instance, component).map((e) => e.id);
    expect(a).toEqual(b);
    expect(a.length).toBeGreaterThan(0);
  });

  it('expandInstance — different instances of the same component get different ids', () => {
    let doc = createEmptyDocument();
    const box = execute(doc, 'add_box', { size: [1, 1, 1], position: [0, 0, 0] });
    doc = box.document;
    const boxId = box.affected[0]!;
    const comp = execute(doc, 'create_component', { name: 'Brick', entityIds: [boxId] });
    doc = comp.document;
    const inst1Id = comp.affected[0]!;
    const inst2 = execute(doc, 'insert_instance', {
      componentId: (doc.entities[inst1Id] as InstanceEntity).componentId,
      position: [5, 0, 0],
    });
    doc = inst2.document;
    const inst2Id = inst2.affected[0]!;

    const instance1 = doc.entities[inst1Id] as InstanceEntity;
    const instance2 = doc.entities[inst2Id] as InstanceEntity;
    const component = doc.components[instance1.componentId] as Component;

    const ids1 = expandInstance(instance1, component).map((e) => e.id);
    const ids2 = expandInstance(instance2, component).map((e) => e.id);
    // No id should appear in both arrays — instances are namespaced apart.
    const overlap = ids1.filter((id) => ids2.includes(id));
    expect(overlap).toHaveLength(0);
  });

  it('expandInstance — expanded ids include both the instance id and source entity id', () => {
    let doc = createEmptyDocument();
    const box = execute(doc, 'add_box', { size: [1, 1, 1], position: [0, 0, 0] });
    doc = box.document;
    const boxId = box.affected[0]!;
    const comp = execute(doc, 'create_component', { name: 'Brick', entityIds: [boxId] });
    doc = comp.document;
    const instanceId = comp.affected[0]!;

    const instance = doc.entities[instanceId] as InstanceEntity;
    const component = doc.components[instance.componentId] as Component;
    const expanded = expandInstance(instance, component);
    expect(expanded.length).toBe(1);
    const expandedId = expanded[0]!.id;
    expect(expandedId).toContain(instanceId);
    expect(expandedId).not.toBe(boxId); // not the raw source id
  });
});
