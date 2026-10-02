/**
 * Keyboard shortcuts: undo/redo/delete/escape dispatch through the store,
 * and are ignored while typing in form fields.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { useStore, useToolStore } from '@ui/store';
import { createEmptyDocument } from '@core/model/types';
import { useKeyboardShortcuts } from '@ui/hooks/useKeyboardShortcuts';
import { execute } from '@core/commands/registry';

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
    useToolStore.setState({
      viewMode: '3d',
      drawTool: 'none',
      gizmoMode: 'translate',
      shortcutsOpen: false,
    });
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

  it('Delete routes generated building geometry to delete_building_element', () => {
    const walled = execute(createEmptyDocument(), 'add_wall', {
      start: [0, 0],
      end: [1000, 0],
    }).document;
    useStore.setState({ document: { ...walled, selection: ['wall-1:body-0', 'a'] } });
    render(<Harness />);
    fireEvent.keyDown(window, { key: 'Delete' });
    expect(dispatch.mock.calls).toEqual([
      ['delete_building_element', { elementIds: ['wall-1'] }],
      ['delete_entities', { ids: ['a'] }],
    ]);
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

  it('Escape leaves the selection alone while a 2D tool is armed (the tool consumes it)', () => {
    useToolStore.setState({ viewMode: '2d', drawTool: 'line' });
    render(<Harness />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(clearSelection).not.toHaveBeenCalled();
  });

  it('Ctrl+D duplicates every selected entity', () => {
    render(<Harness />);
    fireEvent.keyDown(window, { key: 'd', ctrlKey: true });
    expect(dispatch.mock.calls.map((call) => call[0])).toEqual([
      'duplicate_entity',
      'duplicate_entity',
    ]);
  });

  it('arrow keys nudge the selection by 1, Shift by 10', () => {
    render(<Harness />);
    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    fireEvent.keyDown(window, { key: 'ArrowUp', shiftKey: true });
    expect(dispatch.mock.calls).toEqual([
      ['move_entity', { id: 'a', delta: [-1, 0, 0] }],
      ['move_entity', { id: 'b', delta: [-1, 0, 0] }],
      ['move_entity', { id: 'a', delta: [0, 10, 0] }],
      ['move_entity', { id: 'b', delta: [0, 10, 0] }],
    ]);
  });

  it('arrow keys do nothing without a selection', () => {
    useStore.setState({ document: createEmptyDocument() });
    render(<Harness />);
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    fireEvent.keyDown(window, { key: 'Delete' });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('tool keys arm draw tools, set the gizmo and switch views', () => {
    render(<Harness />);
    fireEvent.keyDown(window, { key: 'r' });
    expect(useToolStore.getState().gizmoMode).toBe('rotate');
    fireEvent.keyDown(window, { key: 'l' });
    expect(useToolStore.getState()).toMatchObject({ drawTool: 'line', viewMode: '2d' });
    fireEvent.keyDown(window, { key: 'r' });
    expect(useToolStore.getState().drawTool).toBe('rectangle');
    fireEvent.keyDown(window, { key: '3' });
    expect(useToolStore.getState()).toMatchObject({ drawTool: 'none', viewMode: '3d' });
    fireEvent.keyDown(window, { key: 'q' });
    expect(useToolStore.getState().viewMode).toBe('3d');
  });

  it('tool keys are ignored with Ctrl/Alt held', () => {
    render(<Harness />);
    fireEvent.keyDown(window, { key: 'l', altKey: true });
    fireEvent.keyDown(window, { key: 'l', ctrlKey: true });
    expect(useToolStore.getState().drawTool).toBe('none');
  });

  it('? opens the shortcut sheet', () => {
    render(<Harness />);
    fireEvent.keyDown(window, { key: '?' });
    expect(useToolStore.getState().shortcutsOpen).toBe(true);
  });
});
