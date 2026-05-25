/**
 * Component tests for <Toolbar />.
 *
 * Asserts observable behavior (buttons rendered, dispatch called, store updated)
 * NOT internals or geometry math (workflow W3, react R11).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { __resetIdCounter } from '@lib/id';
import { listCommands } from '@core/commands/registry';
import { useStore } from '@ui/store';
import { createEmptyDocument } from '@core/model/types';
import { Toolbar } from '@ui/components/Toolbar';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resetStore(): void {
  useStore.setState({ document: createEmptyDocument(), lastSummary: null });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Toolbar', () => {
  beforeEach(() => {
    __resetIdCounter();
    resetStore();
  });

  it('renders one button per listCommands() entry', () => {
    render(<Toolbar />);

    const commands = listCommands();
    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(commands.length);
  });

  it('each button has an accessible label from its command description', () => {
    render(<Toolbar />);

    for (const cmd of listCommands()) {
      // aria-label is set to cmd.description
      const btn = screen.getByRole('button', { name: cmd.description });
      expect(btn).toBeDefined();
    }
  });

  it('each button has a title attribute matching its command description', () => {
    render(<Toolbar />);

    for (const cmd of listCommands()) {
      const btn = screen.getByRole('button', { name: cmd.description });
      expect(btn).toHaveAttribute('title', cmd.description);
    }
  });

  it('buttons have human-readable labels derived from command names', () => {
    render(<Toolbar />);

    // "add_box" → "Add Box"
    const addBoxBtn = screen.getByText('Add Box');
    expect(addBoxBtn).toBeDefined();
  });

  it('clicking the Add Box button dispatches add_box and creates a box entity', () => {
    render(<Toolbar />);

    const addBoxBtn = screen.getByText('Add Box');
    fireEvent.click(addBoxBtn);

    const { document, lastSummary } = useStore.getState();
    expect(document.order).toHaveLength(1);
    const entityId = document.order[0]!;
    expect(document.entities[entityId]?.kind).toBe('box');
    expect(lastSummary).toBeTruthy();
    expect(lastSummary).toContain('box');
  });

  it('clicking a command that requires params gracefully no-ops (status bar updates)', () => {
    render(<Toolbar />);

    // move_entity requires an `id` param — dispatching {} produces a graceful no-op
    const moveBtn = screen.getByText('Move Entity');
    fireEvent.click(moveBtn);

    const { document, lastSummary } = useStore.getState();
    // No entity should have been created
    expect(document.order).toHaveLength(0);
    // But a summary should be set (the graceful-no-op message)
    expect(lastSummary).toBeTruthy();
  });

  it('successive Add Box clicks accumulate entities', () => {
    render(<Toolbar />);

    const addBoxBtn = screen.getByText('Add Box');
    fireEvent.click(addBoxBtn);
    fireEvent.click(addBoxBtn);

    expect(useStore.getState().document.order).toHaveLength(2);
  });

  it('accepts a custom commands prop (used for isolated testing)', () => {
    const subset = listCommands().slice(0, 2);
    render(<Toolbar commands={subset} />);

    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(2);
  });
});
