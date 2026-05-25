/**
 * Component tests for useKeyboardShortcuts.
 *
 * Asserts observable behavior (R11, W3):
 *   - Ctrl+Z calls store.undo().
 *   - Ctrl+Shift+Z calls store.redo().
 *   - Ctrl+Y calls store.redo().
 *   - Ctrl+K calls onOpenPalette.
 *   - Delete dispatches delete_entity for each selected id.
 *   - Shortcuts are suppressed when focus is inside an <input>.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render } from '@testing-library/react';
import React from 'react';
import { __resetIdCounter } from '@lib/id';
import { useStore } from '@ui/store';
import { createEmptyDocument } from '@core/model/types';
import { useKeyboardShortcuts } from '@ui/hooks/useKeyboardShortcuts';

// ---------------------------------------------------------------------------
// Minimal host component that mounts the hook
// ---------------------------------------------------------------------------

interface HostProps {
  onOpenPalette: () => void;
}

function Host({ onOpenPalette }: HostProps): React.ReactElement {
  useKeyboardShortcuts({ onOpenPalette });
  return <div data-testid="host"><input data-testid="text-input" type="text" /></div>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resetStore(): void {
  useStore.setState({ document: createEmptyDocument(), lastSummary: null, undoStack: [], redoStack: [] });
}

/** Fire a keydown on window directly (what the hook listens to). */
function pressKey(
  key: string,
  opts: { ctrlKey?: boolean; shiftKey?: boolean; metaKey?: boolean } = {},
  target: EventTarget = window,
): void {
  const event = new KeyboardEvent('keydown', {
    key,
    ctrlKey: opts.ctrlKey ?? false,
    shiftKey: opts.shiftKey ?? false,
    metaKey: opts.metaKey ?? false,
    bubbles: true,
  });
  target.dispatchEvent(event);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useKeyboardShortcuts', () => {
  beforeEach(() => {
    __resetIdCounter();
    resetStore();
  });

  it('Ctrl+K calls onOpenPalette', () => {
    const onOpenPalette = vi.fn();
    render(<Host onOpenPalette={onOpenPalette} />);
    pressKey('k', { ctrlKey: true });
    expect(onOpenPalette).toHaveBeenCalledOnce();
  });

  it('Cmd+K (metaKey) also calls onOpenPalette', () => {
    const onOpenPalette = vi.fn();
    render(<Host onOpenPalette={onOpenPalette} />);
    pressKey('k', { metaKey: true });
    expect(onOpenPalette).toHaveBeenCalledOnce();
  });

  it('Ctrl+Z calls store.undo()', () => {
    // Set up a non-empty undo stack by dispatching a command.
    useStore.getState().dispatch('add_box', { size: [1, 1, 1] });
    const undoBefore = useStore.getState().document.order.length;

    render(<Host onOpenPalette={vi.fn()} />);
    pressKey('z', { ctrlKey: true });

    const after = useStore.getState().document.order.length;
    expect(after).toBeLessThan(undoBefore);
  });

  it('Ctrl+Shift+Z calls store.redo()', () => {
    useStore.getState().dispatch('add_box', { size: [1, 1, 1] });
    // Undo to populate redoStack.
    useStore.getState().undo();
    const beforeRedo = useStore.getState().document.order.length;

    render(<Host onOpenPalette={vi.fn()} />);
    pressKey('z', { ctrlKey: true, shiftKey: true });

    const after = useStore.getState().document.order.length;
    expect(after).toBeGreaterThan(beforeRedo);
  });

  it('Ctrl+Y also calls store.redo()', () => {
    useStore.getState().dispatch('add_box', { size: [1, 1, 1] });
    useStore.getState().undo();
    const beforeRedo = useStore.getState().document.order.length;

    render(<Host onOpenPalette={vi.fn()} />);
    pressKey('y', { ctrlKey: true });

    const after = useStore.getState().document.order.length;
    expect(after).toBeGreaterThan(beforeRedo);
  });

  it('Delete dispatches delete_entity for each selected entity', () => {
    const result = useStore.getState().dispatch('add_box', { size: [1, 1, 1] });
    const id = result.affected[0]!;
    useStore.getState().select([id]);

    render(<Host onOpenPalette={vi.fn()} />);
    pressKey('Delete');

    expect(useStore.getState().document.order).toHaveLength(0);
  });

  it('Backspace also deletes selected entities', () => {
    const result = useStore.getState().dispatch('add_box', { size: [1, 1, 1] });
    const id = result.affected[0]!;
    useStore.getState().select([id]);

    render(<Host onOpenPalette={vi.fn()} />);
    pressKey('Backspace');

    expect(useStore.getState().document.order).toHaveLength(0);
  });

  it('Delete is suppressed when focus is in an <input>', () => {
    const result = useStore.getState().dispatch('add_box', { size: [1, 1, 1] });
    const id = result.affected[0]!;
    useStore.getState().select([id]);

    const { getByTestId } = render(<Host onOpenPalette={vi.fn()} />);
    const input = getByTestId('text-input') as HTMLInputElement;

    // Dispatch from the input element so isTypingTarget returns true.
    pressKey('Delete', {}, input);

    // Entity should NOT be deleted.
    expect(useStore.getState().document.order).toHaveLength(1);
  });

  it('Ctrl+Z is suppressed when focus is in an <input>', () => {
    useStore.getState().dispatch('add_box', { size: [1, 1, 1] });
    const countBefore = useStore.getState().document.order.length;

    const { getByTestId } = render(<Host onOpenPalette={vi.fn()} />);
    const input = getByTestId('text-input') as HTMLInputElement;

    pressKey('z', { ctrlKey: true }, input);

    // Document should be unchanged.
    expect(useStore.getState().document.order.length).toBe(countBefore);
  });
});
