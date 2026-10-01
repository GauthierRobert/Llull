/**
 * Keyboard shortcuts: undo/redo/delete/escape dispatch through the store,
 * and are ignored while typing in form fields.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { useStore } from '@ui/store';
import { createEmptyDocument } from '@core/model/types';
import { useKeyboardShortcuts } from '@ui/hooks/useKeyboardShortcuts';

function Harness(): React.ReactElement {
  useKeyboardShortcuts();
  return <input aria-label="field" />;
}

describe('useKeyboardShortcuts', () => {
  const undo = vi.fn();
  const redo = vi.fn();
  const dispatch = vi.fn();
  const clearSelection = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    useStore.setState({
      document: { ...createEmptyDocument(), selection: ['a', 'b'] },
      undo,
      redo,
      dispatch,
      clearSelection,
    });
  });

  it('Ctrl+Z undoes, Ctrl+Y and Ctrl+Shift+Z redo', () => {
    render(<Harness />);
    fireEvent.keyDown(window, { key: 'z', ctrlKey: true });
    fireEvent.keyDown(window, { key: 'y', ctrlKey: true });
    fireEvent.keyDown(window, { key: 'z', ctrlKey: true, shiftKey: true });
    expect(undo).toHaveBeenCalledTimes(1);
    expect(redo).toHaveBeenCalledTimes(2);
  });

  it('Delete dispatches one delete_entities call with all selected ids', () => {
    render(<Harness />);
    fireEvent.keyDown(window, { key: 'Delete' });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith('delete_entities', { ids: ['a', 'b'] });
  });

  it('ignores auto-repeat and already-handled key events', () => {
    render(<Harness />);
    fireEvent.keyDown(window, { key: 'Delete', repeat: true });
    fireEvent.keyDown(window, { key: 'z', ctrlKey: true, repeat: true });
    expect(dispatch).not.toHaveBeenCalled();
    expect(undo).not.toHaveBeenCalled();
  });

  it('ignores shortcuts originating inside an open dialog', () => {
    const { getByTestId } = render(
      <>
        <Harness />
        <div role="dialog">
          <button data-testid="in-dialog" type="button" />
        </div>
      </>,
    );
    fireEvent.keyDown(getByTestId('in-dialog'), { key: 'Delete' });
    fireEvent.keyDown(getByTestId('in-dialog'), { key: 'z', ctrlKey: true });
    expect(dispatch).not.toHaveBeenCalled();
    expect(undo).not.toHaveBeenCalled();
  });

  it('Escape clears selection', () => {
    render(<Harness />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(clearSelection).toHaveBeenCalled();
  });

  it('ignores shortcuts while typing in an input', () => {
    const { getByLabelText } = render(<Harness />);
    const input = getByLabelText('field');
    fireEvent.keyDown(input, { key: 'z', ctrlKey: true });
    fireEvent.keyDown(input, { key: 'Delete' });
    expect(undo).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });
});
