import { resetStore } from '../helpers/componentEntities';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { useStore } from '@ui/store';
import { AssemblyPanel } from '@ui/panels/AssemblyPanel';
import { localDispatch } from '../helpers/storeTestHelpers';

// Helpers

// Tests

/** A unit box wrapped in component `name` and instanced once; returns the instance id. */
function insertedInstance(name: string): string {
  const boxResult = localDispatch('add_box', { size: [1, 1, 1] });
  localDispatch('create_component', { name, entityIds: [boxResult.affected[0]!] });
  const compId = Object.keys(useStore.getState().document.components)[0]!;
  return localDispatch('insert_instance', { componentId: compId }).affected[0]!;
}

describe('AssemblyPanel — empty state', () => {
  beforeEach(() => {
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
    localDispatch('create_component', { name: 'TwoPartComp', entityIds: [r1.affected[0]!, r2.affected[0]!] });
    render(<AssemblyPanel />);
    // The count chip should show "2" for the two-entity component.
    expect(screen.getByLabelText('2 entities')).toBeDefined();
  });
  it('Insert button dispatches insert_instance for the correct component', () => {
    const boxResult = localDispatch('add_box', { size: [1, 1, 1] });
    const compResult = localDispatch('create_component', { name: 'Gear', entityIds: [boxResult.affected[0]!] });
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
    const instanceId = insertedInstance('Pin');
    const selectSpy = vi.spyOn(useStore.getState(), 'select');
    render(<AssemblyPanel />);
    const instanceRow = screen.getByTestId(`assembly-instance-${instanceId}`);
    fireEvent.click(instanceRow);
    expect(selectSpy).toHaveBeenCalledWith([instanceId]);
    selectSpy.mockRestore();
  });
  it('Explode button dispatches explode_instance with the correct id', () => {
    const instanceId = insertedInstance('Widget');
    const dispatchSpy = vi.spyOn(useStore.getState(), 'dispatch').mockResolvedValue();
    render(<AssemblyPanel />);
    fireEvent.click(screen.getByRole('button', { name: `Explode instance ${instanceId}` }));
    expect(dispatchSpy).toHaveBeenCalledWith('explode_instance', { id: instanceId });
    dispatchSpy.mockRestore();
  });
  it('selected instance row has the selected CSS class', () => {
    const instanceId = insertedInstance('Cap');
    // Pre-select the instance in the store so the component renders it selected.
    useStore.setState({ document: { ...useStore.getState().document, selection: [instanceId] } });
    render(<AssemblyPanel />);
    const row = screen.getByTestId(`assembly-instance-${instanceId}`);
    expect(row.className).toContain('assembly-instance-row--selected');
  });
  it('exposes each instance as a keyboard-operable button reflecting selection', () => {
    const instanceId = insertedInstance('Bolt');
    render(<AssemblyPanel />);
    const row = screen.getByTestId(`assembly-instance-${instanceId}`);
    const pick = within(row).getByRole('button', { name: 'Select instance of Bolt' });
    expect(pick).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(pick);
    expect(useStore.getState().document.selection).toEqual([instanceId]);
    expect(pick).toHaveAttribute('aria-pressed', 'true');
  });
});
