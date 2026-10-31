import { resetStore } from '../helpers/componentEntities';
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, within, fireEvent } from '@testing-library/react';
import { useStore } from '@ui/store';
import { createEmptyDocument } from '@core/model/types';
import { PropertiesPanel } from '@ui/panels/PropertiesPanel';
import { localDispatch } from '../helpers/storeTestHelpers';
import { xy } from '../helpers/xy';

// Helpers

function createBox(size: [number, number, number] = [2, 2, 2]): string {
  const result = localDispatch('add_box', { size });
  return result.affected[0]!;
}

// SelectionSection tests

describe('PropertiesPanel — selection inspector', () => {
  beforeEach(() => {
    resetStore();
  });
  it('shows "No entity selected" when nothing is selected', () => {
    render(<PropertiesPanel />);
    expect(screen.getByText(/no entity selected/i)).toBeDefined();
  });
  it('shows entity kind and id when a single entity is selected', () => {
    const id = createBox();
    useStore.getState().select([id]);
    render(<PropertiesPanel />);
    expect(screen.getByText('box')).toBeDefined();
    expect(screen.getByText(id)).toBeDefined();
  });
  it('shows a summary count for multiple selections', () => {
    const id1 = createBox();
    const id2 = createBox([3, 3, 3]);
    useStore.getState().select([id1, id2]);
    render(<PropertiesPanel />);
    expect(screen.getByText(/2 entities selected/i)).toBeDefined();
  });
  it.each([
    ['Size field for a box entity', 'Size', [1, 2, 3]],
    ['Position field for any selected entity', 'Position', undefined],
    ['Color field for a selected entity', 'Color', undefined],
  ] as const)('shows %s', (_label, field, size) => {
    const id = createBox(size && [...size]);
    useStore.getState().select([id]);
    render(<PropertiesPanel />);
    const selectionSection = screen.getByRole('region', { name: /selection/i });
    expect(within(selectionSection).getByText(field)).toBeDefined();
  });
});

// Viewer mode — no mutation controls

describe('PropertiesPanel — no mutation controls in viewer mode', () => {
  beforeEach(() => {
    resetStore();
  });
  it('does NOT render a Run Command section', () => {
    render(<PropertiesPanel />);
    expect(screen.queryByRole('region', { name: /run command/i })).toBeNull();
  });
  it('does NOT render a command selector dropdown', () => {
    render(<PropertiesPanel />);
    expect(screen.queryByRole('combobox')).toBeNull();
  });
  it('does NOT render a Run button', () => {
    render(<PropertiesPanel />);
    expect(screen.queryByRole('button', { name: /run/i })).toBeNull();
  });
});

// Editing — every committed field dispatches a command

describe('PropertiesPanel — editing', () => {
  beforeEach(() => {
    useStore.getState().setDocument(createEmptyDocument());
    useStore.setState({ liveStatus: 'disconnected' });
  });
  function commit(label: string, value: string): void {
    const input = screen.getByLabelText(label);
    fireEvent.change(input, { target: { value } });
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.blur(input);
  }
  it('typing a position moves the entity to that coordinate', () => {
    const id = createBox();
    useStore.getState().select([id]);
    render(<PropertiesPanel />);
    commit('Position X', '5');
    commit('Position Z', '-2.5');
    expect(useStore.getState().document.entities[id]?.position).toEqual([5, 0, -2.5]);
  });
  it('typing a rotation in degrees rotates the entity', () => {
    const id = createBox();
    useStore.getState().select([id]);
    render(<PropertiesPanel />);
    commit('Rotation Z', '90');
    expect(useStore.getState().document.entities[id]?.rotation[2]).toBeCloseTo(Math.PI / 2);
  });
  it('typing a name renames the entity', () => {
    const id = createBox();
    useStore.getState().select([id]);
    render(<PropertiesPanel />);
    commit('Name', 'Base plate');
    expect(useStore.getState().document.entities[id]?.name).toBe('Base plate');
  });
  it('non-numeric or unchanged input dispatches nothing', () => {
    const id = createBox();
    useStore.getState().select([id]);
    render(<PropertiesPanel />);
    const before = useStore.getState().document;
    commit('Position Y', 'abc');
    const unchanged = screen.getByLabelText('Position X');
    fireEvent.blur(unchanged);
    expect(useStore.getState().document).toBe(before);
  });
  it('Escape reverts a draft', () => {
    const id = createBox();
    useStore.getState().select([id]);
    render(<PropertiesPanel />);
    const input = screen.getByLabelText('Position X');
    fireEvent.change(input, { target: { value: '9' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    fireEvent.blur(input);
    expect(useStore.getState().document.entities[id]?.position[0]).toBe(0);
  });
  it('Duplicate and Delete act on the selection', () => {
    const id = createBox();
    useStore.getState().select([id]);
    render(<PropertiesPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Duplicate' }));
    expect(useStore.getState().document.order).toHaveLength(2);
    useStore.getState().select([id]);
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(useStore.getState().document.entities[id]).toBeUndefined();
  });
  it('typing a size edits the creating step and keeps the entity selected', () => {
    const id = createBox([1, 2, 3]);
    useStore.getState().select([id]);
    render(<PropertiesPanel />);
    commit('Size Y', '7');
    const state = useStore.getState();
    expect(state.document.entities[id]).toMatchObject({ kind: 'box', size: [1, 7, 3] });
    expect(state.document.featureHistory[0]?.params).toMatchObject({ size: [1, 7, 3] });
    expect(state.document.selection).toEqual([id]);
  });
  it('typing a cylinder radius edits its creating step', () => {
    const id = localDispatch('add_cylinder', { radius: 1, height: 2 }).affected[0]!;
    useStore.getState().select([id]);
    render(<PropertiesPanel />);
    commit('Radius', '2.5');
    expect(useStore.getState().document.entities[id]).toMatchObject({ radius: 2.5, height: 2 });
  });
  it('shows a refused dimension edit and leaves the document unchanged', () => {
    const id = createBox();
    useStore.getState().select([id]);
    render(<PropertiesPanel />);
    const before = useStore.getState().document;
    commit('Size X', '-4');
    expect(useStore.getState().document).toBe(before);
    expect(screen.getByRole('alert').textContent).toMatch(/edit_step_params/);
  });
  it('shows a parameter-driven dimension as its read-only expression', () => {
    localDispatch('set_parameter', { name: 'w', expression: '4' });
    const id = Object.keys(localDispatch('insert_step', { name: 'add_box', params: { size: ['=w', 2, 2] } }).document.entities).at(-1)!;
    useStore.getState().select([id]);
    render(<PropertiesPanel />);
    expect(screen.getByText('=w')).toBeDefined();
    expect(screen.queryByLabelText('Size X')).toBeNull();
  });
  it('picking a colour commits set_entity_color once the picker closes', () => {
    const id = createBox();
    useStore.getState().select([id]);
    render(<PropertiesPanel />);
    fireEvent.change(screen.getByLabelText('Color'), { target: { value: '#c8553d' } });
    expect(useStore.getState().document.entities[id]?.color).toBe('#c8553d');
  });
  it('offers rotation for solids only', () => {
    const line = localDispatch('draw_polyline', { points: xy(0, 0, 1, 0) }).affected[0]!;
    useStore.getState().select([line]);
    render(<PropertiesPanel />);
    expect(screen.queryByLabelText('Rotation Z')).toBeNull();
    expect(screen.getByLabelText('Position X')).toBeDefined();
  });
});
