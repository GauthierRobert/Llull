import { describe, it, expect, beforeEach } from 'vitest';
import { act, render, screen, fireEvent, within } from '@testing-library/react';
import { useStore, usePaletteStore, useViewportStore } from '@ui/store';
import { ObjectsPanel } from '@ui/panels/ObjectsPanel';
import { localDispatch, resetOfflineStore } from '../helpers/storeTestHelpers';

function resetStore(): void {
  resetOfflineStore();
  useViewportStore.setState({ hiddenEntityIds: new Set<string>() });
}

function addBox(name?: string): string {
  const id = localDispatch('add_box', { size: [1, 1, 1] }).affected[0]!;
  if (name !== undefined) localDispatch('set_entity_name', { id, name });
  return id;
}

describe('ObjectsPanel', () => {
  beforeEach(resetStore);

  it('shows an empty state for an empty model', () => {
    render(<ObjectsPanel />);
    expect(screen.getByText('No objects yet.')).toBeDefined();
  });

  it('lists every entity, by name when it has one', () => {
    const named = addBox('Propeller');
    const unnamed = addBox();
    render(<ObjectsPanel />);
    expect(within(screen.getByTestId(`object-row-${named}`)).getByText('Propeller')).toBeDefined();
    expect(within(screen.getByTestId(`object-row-${unnamed}`)).getByText(`Box ${unnamed}`)).toBeDefined();
  });

  it('click selects; Ctrl+click adds to the selection', () => {
    const a = addBox('A');
    const b = addBox('B');
    render(<ObjectsPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Select A' }));
    expect(useStore.getState().document.selection).toEqual([a]);
    fireEvent.click(screen.getByRole('button', { name: 'Select B' }), { ctrlKey: true });
    expect(useStore.getState().document.selection).toEqual([a, b]);
  });

  it('the eye hides the entity locally', () => {
    const a = addBox('A');
    render(<ObjectsPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Hide A in viewport' }));
    expect(useViewportStore.getState().hiddenEntityIds.has(a)).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: /Show all/ }));
    expect(useViewportStore.getState().hiddenEntityIds.size).toBe(0);
  });

  it('double-click renames through set_entity_name', () => {
    const a = addBox('A');
    render(<ObjectsPanel />);
    fireEvent.doubleClick(screen.getByRole('button', { name: 'Select A' }));
    const input = screen.getByRole('textbox', { name: 'Rename A' });
    fireEvent.change(input, { target: { value: 'Cylinder bank' } });
    fireEvent.blur(input);
    expect(useStore.getState().document.entities[a]?.name).toBe('Cylinder bank');
  });

  it('nests group members under an expandable group that selects them all', () => {
    const a = addBox('A');
    const b = addBox('B');
    const loose = addBox('Loose');
    localDispatch('group_entities', { ids: [a, b], name: 'Engine' });
    render(<ObjectsPanel />);
    expect(screen.queryByTestId(`object-row-${a}`)).toBeNull();
    expect(screen.getByTestId(`object-row-${loose}`)).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Expand group Engine' }));
    expect(screen.getByTestId(`object-row-${a}`)).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Select group Engine' }));
    expect(useStore.getState().document.selection).toEqual([a, b]);
  });

  it('filters by name', () => {
    const a = addBox('Crankcase');
    const b = addBox('Spinner');
    render(<ObjectsPanel />);
    fireEvent.change(screen.getByRole('searchbox', { name: 'Filter objects' }), { target: { value: 'spin' } });
    expect(screen.queryByTestId(`object-row-${a}`)).toBeNull();
    expect(screen.getByTestId(`object-row-${b}`)).toBeDefined();
  });

  describe('collections', () => {
    function twoLayerModel(boxCount: number): string[] {
      localDispatch('add_layer', { name: 'Walls' });
      const ids = Array.from({ length: boxCount }, (_, index) => addBox(`Box${index}`));
      const walls = Object.values(useStore.getState().document.layers).find((layer) => layer.name === 'Walls')!;
      localDispatch('set_entity_layer', { entityId: ids[0]!, layerId: walls.id });
      return ids;
    }

    it('groups by layer, expanded when small, collapsed when large, and toggles', () => {
      const ids = twoLayerModel(2);
      const { unmount } = render(<ObjectsPanel />);
      expect(screen.getByTestId(`object-row-${ids[0]}`)).toBeDefined();
      fireEvent.click(screen.getByRole('button', { name: 'Collapse Walls' }));
      expect(screen.queryByTestId(`object-row-${ids[0]}`)).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'Expand Walls' }));
      expect(screen.getByTestId(`object-row-${ids[0]}`)).toBeDefined();
      unmount();
    });

    it('starts collapsed above 40 objects and auto-expands the collection of a selected entity', () => {
      const ids = twoLayerModel(45);
      const last = ids[44]!;
      render(<ObjectsPanel />);
      expect(screen.queryByTestId(`object-row-${last}`)).toBeNull();
      act(() => useStore.getState().select([last]));
      expect(screen.getByTestId(`object-row-${last}`)).toBeDefined();
    });

    it('hides a whole collection locally and selects it by name', () => {
      const ids = twoLayerModel(2);
      render(<ObjectsPanel />);
      fireEvent.click(screen.getByRole('button', { name: 'Select all in Walls' }));
      expect(useStore.getState().document.selection).toEqual([ids[0]]);
      fireEvent.click(screen.getByRole('button', { name: 'Hide Walls' }));
      expect(useViewportStore.getState().hiddenEntityIds.has(ids[0]!)).toBe(true);
    });

    it('expands every matching collection while filtering', () => {
      const ids = twoLayerModel(45);
      render(<ObjectsPanel />);
      fireEvent.change(screen.getByRole('searchbox', { name: 'Filter objects' }), { target: { value: 'Box44' } });
      expect(screen.getByTestId(`object-row-${ids[44]}`)).toBeDefined();
    });
  });

  it('the empty state button opens the palette on the command form', () => {
    render(<ObjectsPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Add a box' }));
    expect(usePaletteStore.getState()).toMatchObject({ open: true, pendingCommand: 'add_box' });
  });
});
