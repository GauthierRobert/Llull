/**
 * Ctrl+Z during a draw operation removes the last collected point and does not reach global undo.
 */
import { describe, it, expect, vi } from 'vitest';
import { renderHook, act, fireEvent } from '@testing-library/react';
import { useStore } from '@ui/store';
import { useDrawTool } from '@ui/viewport/2d/useDrawTool';
import { useKeyboardShortcuts } from '@ui/hooks/useKeyboardShortcuts';
import { createEmptyDocument } from '@core/model/types';

describe('draw tool undo', () => {
  it('Ctrl+Z pops the last polyline point instead of undoing the document', () => {
    const undo = vi.fn();
    useStore.setState({ undo });
    const { result } = renderHook(() => {
      useKeyboardShortcuts();
      return useDrawTool();
    });
    act(() => result.current.setActiveTool('polyline'));
    act(() => result.current.handleClick([0, 0]));
    act(() => result.current.handleClick([1, 0]));
    expect(result.current.collectedPoints).toHaveLength(2);

    fireEvent.keyDown(window, { key: 'z', ctrlKey: true });
    expect(result.current.collectedPoints).toEqual([[0, 0]]);
    expect(undo).not.toHaveBeenCalled();

    fireEvent.keyDown(window, { key: 'z', ctrlKey: true });
    fireEvent.keyDown(window, { key: 'z', ctrlKey: true });
    expect(result.current.collectedPoints).toHaveLength(0);
    expect(undo).toHaveBeenCalledTimes(1);
  });
});

describe('draw tool move', () => {
  it('moves the selection by (destination - base point), then waits for the next base point', () => {
    const dispatch = vi.fn();
    useStore.setState({ dispatch, document: { ...createEmptyDocument(), selection: ['a', 'b'] } });
    const { result } = renderHook(() => useDrawTool());
    act(() => result.current.setActiveTool('move'));
    act(() => result.current.handleClick([1, 1]));
    expect(dispatch).not.toHaveBeenCalled();
    act(() => result.current.handleClick([4, -1]));
    expect(dispatch.mock.calls).toEqual([
      ['move_entity', { id: 'a', delta: [3, -2, 0] }],
      ['move_entity', { id: 'b', delta: [3, -2, 0] }],
    ]);
    expect(result.current.collectedPoints).toHaveLength(0);
  });

  it('ignores clicks while nothing is selected', () => {
    const dispatch = vi.fn();
    useStore.setState({ dispatch, document: createEmptyDocument() });
    const { result } = renderHook(() => useDrawTool());
    act(() => result.current.setActiveTool('move'));
    act(() => result.current.handleClick([1, 1]));
    expect(result.current.collectedPoints).toHaveLength(0);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('Esc drops the base point first, then returns to Select', () => {
    useStore.setState({ document: { ...createEmptyDocument(), selection: ['a'] } });
    const { result } = renderHook(() => useDrawTool());
    act(() => result.current.setActiveTool('move'));
    act(() => result.current.handleClick([1, 1]));
    act(() => {
      fireEvent.keyDown(window, { key: 'Escape' });
    });
    expect(result.current.collectedPoints).toHaveLength(0);
    expect(result.current.activeTool).toBe('move');
    act(() => {
      fireEvent.keyDown(window, { key: 'Escape' });
    });
    expect(result.current.activeTool).toBe('none');
  });
});
