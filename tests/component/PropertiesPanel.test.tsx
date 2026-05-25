/**
 * Component tests for <PropertiesPanel /> — viewer mode (read-only inspector).
 *
 * Asserts observable behavior:
 *   - Selection section reflects the store's document.selection.
 *   - Shows entity kind, id, position, and kind-specific fields for a selected entity.
 *   - Shows a summary count for multiple selections.
 *   - The "Run Command" section is absent (viewer mode — commands come from MCP).
 *
 * (workflow W3, react R11 — behavior only, no internals or geometry math)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { __resetIdCounter } from '@lib/id';
import { useStore } from '@ui/store';
import { createEmptyDocument } from '@core/model/types';
import { PropertiesPanel } from '@ui/panels/PropertiesPanel';
import { localDispatch } from '../helpers/storeTestHelpers';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resetStore(): void {
  useStore.setState({ document: createEmptyDocument(), lastSummary: null });
}

function createBox(size: [number, number, number] = [2, 2, 2]): string {
  const result = localDispatch('add_box', { size });
  return result.affected[0]!;
}

// ---------------------------------------------------------------------------
// SelectionSection tests
// ---------------------------------------------------------------------------

describe('PropertiesPanel — selection inspector', () => {
  beforeEach(() => {
    __resetIdCounter();
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

  it('shows Size field for a box entity', () => {
    const id = createBox([1, 2, 3]);
    useStore.getState().select([id]);

    render(<PropertiesPanel />);

    const selectionSection = screen.getByRole('region', { name: /selection/i });
    expect(within(selectionSection).getByText('Size')).toBeDefined();
  });

  it('shows Position field for any selected entity', () => {
    const id = createBox();
    useStore.getState().select([id]);

    render(<PropertiesPanel />);

    const selectionSection = screen.getByRole('region', { name: /selection/i });
    expect(within(selectionSection).getByText('Position')).toBeDefined();
  });

  it('shows Color field for a selected entity', () => {
    const id = createBox();
    useStore.getState().select([id]);

    render(<PropertiesPanel />);

    const selectionSection = screen.getByRole('region', { name: /selection/i });
    expect(within(selectionSection).getByText('Color')).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Viewer mode — no mutation controls
// ---------------------------------------------------------------------------

describe('PropertiesPanel — no mutation controls in viewer mode', () => {
  beforeEach(() => {
    __resetIdCounter();
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
