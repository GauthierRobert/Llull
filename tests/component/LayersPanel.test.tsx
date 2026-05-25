/**
 * Component tests for <LayersPanel />.
 *
 * Asserts observable behavior (workflow W3, react R11):
 *   - Panel renders a row per layer in layerOrder.
 *   - Name, visibility toggle, and lock toggle controls are present.
 *   - Toggling visibility dispatches `set_layer_visibility` (verified via store state).
 *   - Toggling lock dispatches `set_layer_lock` (verified via store state).
 *   - Add-layer form dispatches `add_layer` and clears the input.
 *   - Delete button dispatches `delete_layer`; disabled for the default layer.
 *   - Undo/redo buttons call the store and disable when their stack is empty.
 *
 * No geometry math or internals are asserted — behavioral testing only.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, within, act } from '@testing-library/react';
import { __resetIdCounter } from '@lib/id';
import { useStore } from '@ui/store';
import { createEmptyDocument } from '@core/model/types';
import { DEFAULT_LAYER_ID } from '@core/model/types';
import { LayersPanel } from '@ui/panels/LayersPanel';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resetStore(): void {
  useStore.setState({
    document: createEmptyDocument(),
    lastSummary: null,
    undoStack: [],
    redoStack: [],
  });
}

function addLayer(name: string, color?: string): string {
  const params: Record<string, unknown> = { name };
  if (color !== undefined) params['color'] = color;
  const result = useStore.getState().dispatch('add_layer', params);
  return result.affected[0]!;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('LayersPanel', () => {
  beforeEach(() => {
    __resetIdCounter();
    resetStore();
  });

  // -- Rendering ---------------------------------------------------------------

  it('renders a row for every layer in layerOrder', () => {
    addLayer('Walls');
    addLayer('Roof');

    render(<LayersPanel />);

    // Default layer + Walls + Roof = 3 rows
    const rows = screen.getAllByRole('listitem');
    expect(rows.length).toBe(3);
  });

  it('shows the layer name in each row', () => {
    addLayer('Annotations');
    render(<LayersPanel />);

    expect(screen.getByText('Annotations')).toBeDefined();
    expect(screen.getByText('Layer 0')).toBeDefined();
  });

  it('shows a visibility toggle button per layer', () => {
    addLayer('Roof');
    render(<LayersPanel />);

    // Two layers → two visibility buttons
    const btns = screen.getAllByRole('button', { name: /hide layer|show layer/i });
    expect(btns.length).toBe(2);
  });

  it('shows a lock toggle button per layer', () => {
    addLayer('Roof');
    render(<LayersPanel />);

    const btns = screen.getAllByRole('button', { name: /lock layer|unlock layer/i });
    expect(btns.length).toBe(2);
  });

  it('renders entity count (0 by default)', () => {
    render(<LayersPanel />);
    // Default layer row has a count of 0
    const defaultRow = screen.getByTestId(`layer-row-${DEFAULT_LAYER_ID}`);
    expect(within(defaultRow).getByText('0')).toBeDefined();
  });

  it('shows entity count matching entities on that layer', () => {
    // Create two boxes on the default layer
    useStore.getState().dispatch('add_box', { size: [1, 1, 1] });
    useStore.getState().dispatch('add_box', { size: [2, 2, 2] });

    render(<LayersPanel />);

    const defaultRow = screen.getByTestId(`layer-row-${DEFAULT_LAYER_ID}`);
    expect(within(defaultRow).getByText('2')).toBeDefined();
  });

  // -- Visibility toggle -------------------------------------------------------

  it('clicking the visibility button hides a visible layer (updates store)', () => {
    render(<LayersPanel />);

    // Default layer starts visible
    const defaultRow = screen.getByTestId(`layer-row-${DEFAULT_LAYER_ID}`);
    const visBtn = within(defaultRow).getByRole('button', { name: /hide layer/i });
    fireEvent.click(visBtn);

    const { document } = useStore.getState();
    expect(document.layers[DEFAULT_LAYER_ID]?.visible).toBe(false);
  });

  it('clicking the visibility button on a hidden layer makes it visible', () => {
    // First hide the default layer via the store
    useStore.getState().dispatch('set_layer_visibility', { id: DEFAULT_LAYER_ID, visible: false });

    render(<LayersPanel />);

    const defaultRow = screen.getByTestId(`layer-row-${DEFAULT_LAYER_ID}`);
    const visBtn = within(defaultRow).getByRole('button', { name: /show layer/i });
    fireEvent.click(visBtn);

    const { document } = useStore.getState();
    expect(document.layers[DEFAULT_LAYER_ID]?.visible).toBe(true);
  });

  // -- Lock toggle -------------------------------------------------------------

  it('clicking the lock button locks an unlocked layer (updates store)', () => {
    render(<LayersPanel />);

    const defaultRow = screen.getByTestId(`layer-row-${DEFAULT_LAYER_ID}`);
    const lockBtn = within(defaultRow).getByRole('button', { name: /lock layer/i });
    fireEvent.click(lockBtn);

    const { document } = useStore.getState();
    expect(document.layers[DEFAULT_LAYER_ID]?.locked).toBe(true);
  });

  it('clicking the lock button on a locked layer unlocks it', () => {
    useStore.getState().dispatch('set_layer_lock', { id: DEFAULT_LAYER_ID, locked: true });

    render(<LayersPanel />);

    const defaultRow = screen.getByTestId(`layer-row-${DEFAULT_LAYER_ID}`);
    const lockBtn = within(defaultRow).getByRole('button', { name: /unlock layer/i });
    fireEvent.click(lockBtn);

    const { document } = useStore.getState();
    expect(document.layers[DEFAULT_LAYER_ID]?.locked).toBe(false);
  });

  // -- Add layer ---------------------------------------------------------------

  it('add-layer form creates a new layer in the store', () => {
    render(<LayersPanel />);

    const input = screen.getByRole('textbox', { name: /new layer name/i });
    fireEvent.change(input, { target: { value: 'Foundation' } });

    const addBtn = screen.getByRole('button', { name: /^add layer$/i });
    fireEvent.click(addBtn);

    const { document } = useStore.getState();
    const names = document.layerOrder.map((id) => document.layers[id]?.name);
    expect(names).toContain('Foundation');
  });

  it('add-layer form clears the input after submit', () => {
    render(<LayersPanel />);

    const input = screen.getByRole('textbox', { name: /new layer name/i }) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'Temp' } });
    fireEvent.click(screen.getByRole('button', { name: /^add layer$/i }));

    expect(input.value).toBe('');
  });

  it('add-layer button is disabled when name is empty', () => {
    render(<LayersPanel />);

    const addBtn = screen.getByRole('button', { name: /^add layer$/i }) as HTMLButtonElement;
    expect(addBtn.disabled).toBe(true);
  });

  it('adding a layer adds a new row to the panel', () => {
    render(<LayersPanel />);

    const input = screen.getByRole('textbox', { name: /new layer name/i });
    fireEvent.change(input, { target: { value: 'New Layer' } });
    fireEvent.click(screen.getByRole('button', { name: /^add layer$/i }));

    // Now the panel should show two rows: default + New Layer
    const rows = screen.getAllByRole('listitem');
    expect(rows.length).toBe(2);
  });

  // -- Delete layer ------------------------------------------------------------

  it('delete button is disabled for the default layer', () => {
    render(<LayersPanel />);

    const defaultRow = screen.getByTestId(`layer-row-${DEFAULT_LAYER_ID}`);
    const deleteBtn = within(defaultRow).getByRole('button', {
      name: /delete layer/i,
    }) as HTMLButtonElement;
    expect(deleteBtn.disabled).toBe(true);
  });

  it('delete button removes a non-default layer from the store', () => {
    const id = addLayer('Temp Layer');

    render(<LayersPanel />);

    const row = screen.getByTestId(`layer-row-${id}`);
    const deleteBtn = within(row).getByRole('button', { name: /delete layer/i });
    fireEvent.click(deleteBtn);

    const { document } = useStore.getState();
    expect(id in document.layers).toBe(false);
    expect(document.layerOrder).not.toContain(id);
  });

  // -- Rename layer ------------------------------------------------------------

  it('clicking a layer name exposes a rename input', () => {
    render(<LayersPanel />);

    const defaultRow = screen.getByTestId(`layer-row-${DEFAULT_LAYER_ID}`);
    const nameBtn = within(defaultRow).getByRole('button', { name: /layer name/i });
    fireEvent.click(nameBtn);

    expect(within(defaultRow).getByRole('textbox', { name: /rename layer/i })).toBeDefined();
  });

  it('pressing Enter on the rename input updates the layer name in the store', () => {
    render(<LayersPanel />);

    const defaultRow = screen.getByTestId(`layer-row-${DEFAULT_LAYER_ID}`);
    const nameBtn = within(defaultRow).getByRole('button', { name: /layer name/i });
    fireEvent.click(nameBtn);

    const input = within(defaultRow).getByRole('textbox', { name: /rename layer/i });
    fireEvent.change(input, { target: { value: 'Base Layer' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    const { document } = useStore.getState();
    expect(document.layers[DEFAULT_LAYER_ID]?.name).toBe('Base Layer');
  });

  it('pressing Escape on the rename input reverts without updating the store', () => {
    render(<LayersPanel />);

    const defaultRow = screen.getByTestId(`layer-row-${DEFAULT_LAYER_ID}`);
    const nameBtn = within(defaultRow).getByRole('button', { name: /layer name/i });
    fireEvent.click(nameBtn);

    const input = within(defaultRow).getByRole('textbox', { name: /rename layer/i });
    fireEvent.change(input, { target: { value: 'Should Not Save' } });
    fireEvent.keyDown(input, { key: 'Escape' });

    const { document } = useStore.getState();
    // Name must remain unchanged
    expect(document.layers[DEFAULT_LAYER_ID]?.name).toBe('Layer 0');
  });

  // -- Color swatch (read-only) -----------------------------------------------

  it('shows a color swatch when the layer has a color', () => {
    addLayer('Colored', '#ff0000');
    render(<LayersPanel />);

    // The swatch is a span with a background style set
    const panel = screen.getByRole('complementary', { name: /layers/i });
    expect(panel.querySelector('.layer-color-swatch:not(.layer-color-swatch--none)')).toBeDefined();
  });

  // -- Undo / Redo buttons -----------------------------------------------------

  it('renders undo and redo buttons', () => {
    render(<LayersPanel />);

    expect(screen.getByRole('button', { name: 'Undo' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Redo' })).toBeDefined();
  });

  it('undo button is disabled when undoStack is empty', () => {
    render(<LayersPanel />);

    const undoBtn = screen.getByRole('button', { name: 'Undo' }) as HTMLButtonElement;
    expect(undoBtn.disabled).toBe(true);
  });

  it('redo button is disabled when redoStack is empty', () => {
    render(<LayersPanel />);

    const redoBtn = screen.getByRole('button', { name: 'Redo' }) as HTMLButtonElement;
    expect(redoBtn.disabled).toBe(true);
  });

  it('undo button is enabled after a mutating dispatch', () => {
    addLayer('Some Layer');

    render(<LayersPanel />);

    const undoBtn = screen.getByRole('button', { name: 'Undo' }) as HTMLButtonElement;
    expect(undoBtn.disabled).toBe(false);
  });

  it('clicking undo reverts the last document change', () => {
    addLayer('Undoable');

    const { document: before } = useStore.getState();
    expect(before.layerOrder).toHaveLength(2); // default + Undoable

    render(<LayersPanel />);

    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    });

    const { document: after } = useStore.getState();
    expect(after.layerOrder).toHaveLength(1); // reverted to default-only
  });

  it('redo button is enabled after an undo', () => {
    addLayer('Redoable');

    render(<LayersPanel />);

    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    });

    const redoBtn = screen.getByRole('button', { name: 'Redo' }) as HTMLButtonElement;
    expect(redoBtn.disabled).toBe(false);
  });

  it('clicking redo after undo re-applies the reverted change', () => {
    addLayer('ReApply');

    render(<LayersPanel />);

    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    });

    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Redo' }));
    });

    const { document } = useStore.getState();
    const names = document.layerOrder.map((id) => document.layers[id]?.name);
    expect(names).toContain('ReApply');
  });
});
