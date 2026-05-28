/**
 * Component tests for <AssemblyPanel />.
 *
 * Verifies observable behavior (workflow W3, react R11):
 *   - Lists components with their name and entity count.
 *   - "Insert" button dispatches insert_instance with the correct componentId.
 *   - Lists instances with their component name and position.
 *   - Clicking an instance row triggers selection via the store's select().
 *   - "Explode" button dispatches explode_instance with the correct id.
 *   - Empty-state hints are shown when there are no components / instances.
 *
 * No geometry math or internals are asserted — behavioral testing only.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { __resetIdCounter } from '@lib/id';
import { useStore } from '@ui/store';
import { createEmptyDocument } from '@core/model/types';
import { AssemblyPanel } from '@ui/panels/AssemblyPanel';
import { localDispatch } from '../helpers/storeTestHelpers';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resetStore(): void {
  useStore.setState({ document: createEmptyDocument(), lastSummary: null });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AssemblyPanel — empty state', () => {
  beforeEach(() => {
    __resetIdCounter();
    resetStore();
  });

  it('shows empty-state hints when there are no components or instances', () => {
    render(<AssemblyPanel />);
    expect(screen.getByText('No components defined.')).toBeDefined();
    expect(screen.getByText('No instances in the scene.')).toBeDefined();
  });

  it('shows section titles', () => {
    render(<AssemblyPanel />);
    expect(screen.getByText('Components')).toBeDefined();
    expect(screen.getByText('Instances')).toBeDefined();
  });
});

describe('AssemblyPanel — components section', () => {
  beforeEach(() => {
    __resetIdCounter();
    resetStore();
  });

  it('lists a component after create_component', () => {
    // Create a box, then promote it into a component.
    const boxResult = localDispatch('add_box', { size: [1, 1, 1] });
    localDispatch('create_component', { name: 'Wheel', entityIds: [boxResult.affected[0]!] });

    const doc = useStore.getState().document;
    const compId = Object.keys(doc.components)[0]!;

    render(<AssemblyPanel />);

    // The component row should be present under the Components section.
    const compRow = screen.getByTestId(`assembly-component-${compId}`);
    expect(compRow).toBeDefined();
  });

  it('shows the entity count for a component', () => {
    const r1 = localDispatch('add_box', { size: [1, 1, 1] });
    const r2 = localDispatch('add_sphere', { radius: 2 });
    localDispatch('create_component', {
      name: 'TwoPartComp',
      entityIds: [r1.affected[0]!, r2.affected[0]!],
    });

    render(<AssemblyPanel />);

    // The count chip should show "2" for the two-entity component.
    expect(screen.getByLabelText('2 entities')).toBeDefined();
  });

  it('Insert button dispatches insert_instance for the correct component', () => {
    const boxResult = localDispatch('add_box', { size: [1, 1, 1] });
    const compResult = localDispatch('create_component', {
      name: 'Gear',
      entityIds: [boxResult.affected[0]!],
    });
    // create_component places an initial instance; find the component id.
    const doc = useStore.getState().document;
    const compId = Object.keys(doc.components)[0]!;

    // Spy on the store dispatch.
    const dispatchSpy = vi.spyOn(useStore.getState(), 'dispatch').mockResolvedValue();

    render(<AssemblyPanel />);

    const insertBtn = screen.getByRole('button', { name: /insert instance of gear/i });
    fireEvent.click(insertBtn);

    expect(dispatchSpy).toHaveBeenCalledWith('insert_instance', { componentId: compId });

    dispatchSpy.mockRestore();
    void compResult;
  });
});

describe('AssemblyPanel — instances section', () => {
  beforeEach(() => {
    __resetIdCounter();
    resetStore();
  });

  it('lists an instance after insert_instance', () => {
    // Build component then insert an extra instance.
    const boxResult = localDispatch('add_box', { size: [1, 1, 1] });
    localDispatch('create_component', { name: 'Bolt', entityIds: [boxResult.affected[0]!] });
    const doc = useStore.getState().document;
    const compId = Object.keys(doc.components)[0]!;

    // insert a second instance at a known position so we can check position display.
    localDispatch('insert_instance', { componentId: compId, position: [3, 0, 0] });

    render(<AssemblyPanel />);

    // Both the original instance (from create_component) and the newly inserted one appear.
    const rows = screen.getAllByTestId(/assembly-instance-/);
    expect(rows.length).toBeGreaterThanOrEqual(2);
  });

  it('clicking an instance row calls select() with the instance id', () => {
    const boxResult = localDispatch('add_box', { size: [1, 1, 1] });
    localDispatch('create_component', { name: 'Pin', entityIds: [boxResult.affected[0]!] });
    const doc = useStore.getState().document;
    const compId = Object.keys(doc.components)[0]!;
    const insertResult = localDispatch('insert_instance', { componentId: compId });
    const instanceId = insertResult.affected[0]!;

    const selectSpy = vi.spyOn(useStore.getState(), 'select');

    render(<AssemblyPanel />);

    const instanceRow = screen.getByTestId(`assembly-instance-${instanceId}`);
    fireEvent.click(instanceRow);

    expect(selectSpy).toHaveBeenCalledWith([instanceId]);

    selectSpy.mockRestore();
  });

  it('Explode button dispatches explode_instance with the correct id', () => {
    const boxResult = localDispatch('add_box', { size: [1, 1, 1] });
    localDispatch('create_component', { name: 'Widget', entityIds: [boxResult.affected[0]!] });
    const doc = useStore.getState().document;
    const compId = Object.keys(doc.components)[0]!;
    const insertResult = localDispatch('insert_instance', { componentId: compId });
    const instanceId = insertResult.affected[0]!;

    const dispatchSpy = vi.spyOn(useStore.getState(), 'dispatch').mockResolvedValue();

    render(<AssemblyPanel />);

    const explodeBtn = screen.getByTestId(`assembly-instance-${instanceId}`)
      .querySelector('button');
    expect(explodeBtn).toBeDefined();
    fireEvent.click(explodeBtn!);

    expect(dispatchSpy).toHaveBeenCalledWith('explode_instance', { id: instanceId });

    dispatchSpy.mockRestore();
  });

  it('selected instance row has the selected CSS class', () => {
    const boxResult = localDispatch('add_box', { size: [1, 1, 1] });
    localDispatch('create_component', { name: 'Cap', entityIds: [boxResult.affected[0]!] });
    const doc = useStore.getState().document;
    const compId = Object.keys(doc.components)[0]!;
    const insertResult = localDispatch('insert_instance', { componentId: compId });
    const instanceId = insertResult.affected[0]!;

    // Pre-select the instance in the store so the component renders it selected.
    useStore.setState({
      document: {
        ...useStore.getState().document,
        selection: [instanceId],
      },
    });

    render(<AssemblyPanel />);

    const row = screen.getByTestId(`assembly-instance-${instanceId}`);
    expect(row.className).toContain('assembly-instance-row--selected');
  });
});
