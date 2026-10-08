/**
 * Component tests for <LayersPanel />.
 *
 * Asserts observable behavior (workflow W3, react R11):
 *   - Panel renders a row per layer in layerOrder.
 *   - Layer name, entity count, and color swatch are displayed.
 *   - The local viewport visibility toggle button toggles useViewportStore.hiddenLayerIds
 *     without dispatching any command to the document.
 *   - Add / rename / lock / delete (confirmed) dispatch the layer commands; the default layer
 *     cannot be deleted.
 *
 * No geometry math or internals are asserted — behavioral testing only.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { useStore, useViewportStore } from '@ui/store';
import { createEmptyDocument } from '@core/model/types';
import { DEFAULT_LAYER_ID } from '@core/model/types';
import { LayersPanel } from '@ui/panels/LayersPanel';
import { localDispatch } from '../helpers/storeTestHelpers';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resetStore(): void {
  // setDocument also clears local-edit bookkeeping left by a previous test.
  useStore.getState().setDocument(createEmptyDocument());
  useStore.setState({ lastSummary: null });
  useViewportStore.setState({ hiddenLayerIds: new Set<string>() });
}

function addLayer(name: string, color?: string): string {
  const params: Record<string, unknown> = { name };
  if (color !== undefined) params['color'] = color;
  const result = localDispatch('add_layer', params);
  return result.affected[0]!;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('LayersPanel — read-only viewer', () => {
  beforeEach(() => {
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

  it('renders entity count (0 by default)', () => {
    render(<LayersPanel />);
    const defaultRow = screen.getByTestId(`layer-row-${DEFAULT_LAYER_ID}`);
    expect(within(defaultRow).getByText('0')).toBeDefined();
  });

  it('shows entity count matching entities on that layer', () => {
    localDispatch('add_box', { size: [1, 1, 1] });
    localDispatch('add_box', { size: [2, 2, 2] });

    render(<LayersPanel />);

    const defaultRow = screen.getByTestId(`layer-row-${DEFAULT_LAYER_ID}`);
    expect(within(defaultRow).getByText('2')).toBeDefined();
  });

  it('shows a color swatch when the layer has a color', () => {
    addLayer('Colored', '#ff0000');
    render(<LayersPanel />);

    const panel = screen.getByRole('complementary', { name: /layers/i });
    expect(panel.querySelector('.layer-color-swatch:not(.layer-color-swatch--none)')).toBeDefined();
  });

  // -- Local viewport visibility toggle (no command dispatch) ------------------

  it('shows a visibility toggle button per layer', () => {
    addLayer('Roof');
    render(<LayersPanel />);

    const btns = screen.getAllByRole('button', { name: /hide layer|show layer/i });
    expect(btns.length).toBe(2);
  });

  it('clicking the visibility button adds the layer to hiddenLayerIds (no doc mutation)', () => {
    render(<LayersPanel />);

    const docBefore = useStore.getState().document;

    const defaultRow = screen.getByTestId(`layer-row-${DEFAULT_LAYER_ID}`);
    const visBtn = within(defaultRow).getByRole('button', { name: /hide layer/i });
    fireEvent.click(visBtn);

    // Document must be untouched (PRIME DIRECTIVE)
    expect(useStore.getState().document).toBe(docBefore);

    // Viewport store must reflect the toggle
    expect(useViewportStore.getState().hiddenLayerIds.has(DEFAULT_LAYER_ID)).toBe(true);
  });

  it('clicking the visibility button again removes the layer from hiddenLayerIds', () => {
    render(<LayersPanel />);

    const defaultRow = screen.getByTestId(`layer-row-${DEFAULT_LAYER_ID}`);
    const hideBtn = within(defaultRow).getByRole('button', { name: /hide layer/i });
    fireEvent.click(hideBtn);

    // Layer is now hidden → button should say "show"
    const showBtn = within(defaultRow).getByRole('button', { name: /show layer/i });
    fireEvent.click(showBtn);

    expect(useViewportStore.getState().hiddenLayerIds.has(DEFAULT_LAYER_ID)).toBe(false);
  });

  // -- No mutation controls present -------------------------------------------

  it('does NOT render undo / redo controls', () => {
    render(<LayersPanel />);
    expect(screen.queryByRole('button', { name: /^undo$/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /^redo$/i })).toBeNull();
  });
});

describe('LayersPanel — layer commands', () => {
  beforeEach(() => {
    resetStore();
    useStore.setState({ liveStatus: 'disconnected' });
  });

  const layerNames = (): string[] =>
    Object.values(useStore.getState().document.layers).map((layer) => layer.name);

  it('adds a layer through add_layer and clears the field', () => {
    render(<LayersPanel />);
    const input = screen.getByLabelText('New layer name') as HTMLInputElement;
    expect(screen.getByRole('button', { name: 'Add layer' })).toHaveProperty('disabled', true);
    fireEvent.change(input, { target: { value: 'Walls' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add layer' }));
    expect(layerNames()).toContain('Walls');
    expect(input.value).toBe('');
  });

  it('toggles the document lock through set_layer_lock', () => {
    const id = addLayer('Locky');
    render(<LayersPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Lock layer Locky' }));
    expect(useStore.getState().document.layers[id]?.locked).toBe(true);
    const unlock = screen.getByRole('button', { name: 'Unlock layer Locky' });
    expect(unlock.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(unlock);
    expect(useStore.getState().document.layers[id]?.locked).toBe(false);
  });

  it('renames a layer through rename_layer (Enter commits, Escape cancels)', () => {
    const id = addLayer('Old');
    render(<LayersPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Rename layer Old' }));
    const field = screen.getByRole('textbox', { name: 'Rename layer Old' });
    fireEvent.change(field, { target: { value: 'New' } });
    fireEvent.blur(field);
    expect(useStore.getState().document.layers[id]?.name).toBe('New');
    expect(screen.queryByRole('textbox', { name: /rename layer/i })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Rename layer New' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Rename layer New' }), {
      target: { value: 'Discarded' },
    });
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Rename layer New' }), {
      key: 'Escape',
    });
    expect(useStore.getState().document.layers[id]?.name).toBe('New');
  });

  it('deletes a layer only after confirmation, moving its entities to the default layer', () => {
    const id = addLayer('Temp');
    const box = localDispatch('add_box', { size: [1, 1, 1] }).affected[0]!;
    localDispatch('set_entity_layer', { entityId: box, layerId: id });
    render(<LayersPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Delete layer Temp' }));
    expect(useStore.getState().document.layers[id]).toBeDefined();
    expect(screen.getByRole('dialog').textContent).toContain('1 entity moves to the default layer');
    fireEvent.click(screen.getByRole('button', { name: 'Delete layer' }));
    expect(useStore.getState().document.layers[id]).toBeUndefined();
    expect(useStore.getState().document.entities[box]?.layerId).toBe(DEFAULT_LAYER_ID);
  });

  it('cancelling the confirmation keeps the layer; the default layer cannot be deleted', () => {
    const id = addLayer('Keep');
    render(<LayersPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Delete layer Keep' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(useStore.getState().document.layers[id]).toBeDefined();
    const defaultName = useStore.getState().document.layers[DEFAULT_LAYER_ID]!.name;
    expect(screen.getByRole('button', { name: `Delete layer ${defaultName}` })).toHaveProperty(
      'disabled',
      true,
    );
  });
});
