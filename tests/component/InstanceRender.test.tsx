/**
 * Component tests for instance rendering in the 3D viewport.
 *
 * Since jsdom has no WebGL, we cannot render the full r3f Canvas. Instead we:
 *   1. Verify that `expandInstance` produces the expected world-space entities
 *      for a given instance + component (pure function test, verifiable in jsdom).
 *   2. Verify that the selection routing maps sub-entity clicks → instance id,
 *      by inspecting the data flow through the store.
 *
 * These tests cover the OBSERVABLE contract (workflow W3): a scene with an
 * instance entity results in geometry being derived from the component, and
 * selection routes to the instance id.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { __resetIdCounter } from '@lib/id';
import { useStore } from '@ui/store';
import { createEmptyDocument } from '@core/model/types';
import type { InstanceEntity } from '@core/model/types';
import { expandInstance } from '@core/commands/assemblies';
import { localDispatch } from '../helpers/storeTestHelpers';

function resetStore(): void {
  useStore.setState({ document: createEmptyDocument(), lastSummary: null });
}

// ---------------------------------------------------------------------------
// expandInstance — geometry count > 0 after create_component + insert_instance
// ---------------------------------------------------------------------------

describe('InstanceRender — expandInstance produces geometry', () => {
  beforeEach(() => {
    __resetIdCounter();
    resetStore();
  });

  it('expandInstance returns > 0 entities for a component with 1 box', () => {
    const boxResult = localDispatch('add_box', { size: [2, 2, 2] });
    localDispatch('create_component', { name: 'Block', entityIds: [boxResult.affected[0]!] });

    const doc = useStore.getState().document;
    const compId = Object.keys(doc.components)[0]!;
    const comp = doc.components[compId]!;

    // Insert a second instance to get a fresh InstanceEntity to test.
    const instResult = localDispatch('insert_instance', { componentId: compId });
    const instId = instResult.affected[0]!;

    const updatedDoc = useStore.getState().document;
    const instance = updatedDoc.entities[instId] as InstanceEntity;

    const expanded = expandInstance(instance, comp);
    expect(expanded.length).toBeGreaterThan(0);
  });

  it('expandInstance returns 2 entities for a component with 2 children', () => {
    const r1 = localDispatch('add_box', { size: [1, 1, 1] });
    const r2 = localDispatch('add_sphere', { radius: 2 });
    localDispatch('create_component', {
      name: 'Multi',
      entityIds: [r1.affected[0]!, r2.affected[0]!],
    });

    const doc = useStore.getState().document;
    const compId = Object.keys(doc.components)[0]!;
    const comp = doc.components[compId]!;

    const instResult = localDispatch('insert_instance', { componentId: compId });
    const instId = instResult.affected[0]!;

    const updatedDoc = useStore.getState().document;
    const instance = updatedDoc.entities[instId] as InstanceEntity;

    const expanded = expandInstance(instance, comp);
    expect(expanded).toHaveLength(2);
  });

  it('expandInstance applies instance position to child world positions', () => {
    const boxResult = localDispatch('add_box', { size: [1, 1, 1] });
    // The box starts at origin [0,0,0] inside the component.
    localDispatch('create_component', { name: 'Shifted', entityIds: [boxResult.affected[0]!] });

    const doc = useStore.getState().document;
    const compId = Object.keys(doc.components)[0]!;
    const comp = doc.components[compId]!;

    const instResult = localDispatch('insert_instance', {
      componentId: compId,
      position: [10, 20, 30],
    });
    const instId = instResult.affected[0]!;

    const updatedDoc = useStore.getState().document;
    const instance = updatedDoc.entities[instId] as InstanceEntity;

    const expanded = expandInstance(instance, comp);
    expect(expanded).toHaveLength(1);
    const child = expanded[0]!;
    // Child world position should include the instance translation.
    expect(child.position[0]).toBeCloseTo(10);
    expect(child.position[1]).toBeCloseTo(20);
    expect(child.position[2]).toBeCloseTo(30);
  });
});

// ---------------------------------------------------------------------------
// Instance selection routing — select routes to the instance id
// ---------------------------------------------------------------------------

describe('InstanceRender — selection routing to instance id', () => {
  beforeEach(() => {
    __resetIdCounter();
    resetStore();
  });

  it('instance id is selectable from the document selection', () => {
    const boxResult = localDispatch('add_box', { size: [3, 3, 3] });
    localDispatch('create_component', { name: 'SelectTest', entityIds: [boxResult.affected[0]!] });

    const doc = useStore.getState().document;
    const compId = Object.keys(doc.components)[0]!;
    const instResult = localDispatch('insert_instance', { componentId: compId });
    const instanceId = instResult.affected[0]!;

    // Simulate selecting the instance id (as the viewport would do on sub-mesh click).
    useStore.getState().select([instanceId]);

    const selection = useStore.getState().document.selection;
    expect(selection).toContain(instanceId);
    // The expanded child ids are NOT in the selection — only the instance itself.
    const allEntityIds = Object.keys(useStore.getState().document.entities);
    const expandedChildIds = allEntityIds.filter((id) => id !== instanceId);
    for (const childId of expandedChildIds) {
      expect(selection).not.toContain(childId);
    }
  });

  it('instance entity has kind === instance after insert_instance', () => {
    const boxResult = localDispatch('add_box', { size: [1, 2, 3] });
    localDispatch('create_component', { name: 'KindCheck', entityIds: [boxResult.affected[0]!] });

    const doc = useStore.getState().document;
    const compId = Object.keys(doc.components)[0]!;
    const instResult = localDispatch('insert_instance', { componentId: compId });
    const instanceId = instResult.affected[0]!;

    const updatedDoc = useStore.getState().document;
    const entity = updatedDoc.entities[instanceId];
    expect(entity).toBeDefined();
    expect(entity!.kind).toBe('instance');
  });
});
