/**
 * Ctrl+Z during a draw operation removes the last collected point and does not reach global undo.
 */
import { describe, it, expect, vi } from 'vitest';
import { renderHook, act, fireEvent } from '@testing-library/react';
import { useStore } from '@ui/store';
import { useDrawTool } from '@ui/viewport/2d/useDrawTool';
import { useKeyboardShortcuts } from '@ui/hooks/useKeyboardShortcuts';

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
