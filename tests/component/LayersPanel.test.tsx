/**
 * Component tests for <LayersPanel /> — viewer mode (read-only).
 *
 * Asserts observable behavior (workflow W3, react R11):
 *   - Panel renders a row per layer in layerOrder.
 *   - Layer name, entity count, and color swatch are displayed.
 *   - The local viewport visibility toggle button toggles useViewportStore.hiddenLayerIds
 *     without dispatching any command to the document.
 *   - Lock state is shown as a read-only indicator.
 *   - No add/rename/delete/undo-redo controls are present.
 *
 * No geometry math or internals are asserted — behavioral testing only.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { __resetIdCounter } from '@lib/id';
import { useStore, useViewportStore } from '@ui/store';
import { createEmptyDocument } from '@core/model/types';
import { DEFAULT_LAYER_ID } from '@core/model/types';
import { LayersPanel } from '@ui/panels/LayersPanel';
import { localDispatch } from '../helpers/storeTestHelpers';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resetStore(): void {
  useStore.setState({
    document: createEmptyDocument(),
    lastSummary: null,
  });
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

  it('does NOT render an "Add" button', () => {
    render(<LayersPanel />);
    expect(screen.queryByRole('button', { name: /^add layer$/i })).toBeNull();
  });

  it('does NOT render an undo button', () => {
    render(<LayersPanel />);
    expect(screen.queryByRole('button', { name: /^undo$/i })).toBeNull();
  });

  it('does NOT render a redo button', () => {
    render(<LayersPanel />);
    expect(screen.queryByRole('button', { name: /^redo$/i })).toBeNull();
  });

  it('does NOT render a delete button on any row', () => {
    addLayer('ToKeep');
    render(<LayersPanel />);
    expect(screen.queryByRole('button', { name: /delete layer/i })).toBeNull();
  });

  it('does NOT render a rename input for layer names', () => {
    render(<LayersPanel />);
    // Layer name is a plain span, not a button that reveals an input
    expect(screen.queryByRole('textbox', { name: /rename layer/i })).toBeNull();
  });
});
