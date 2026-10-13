import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useStore } from '@ui/store';
import { useDrawTool } from '@ui/viewport/2d/useDrawTool';
import { createEmptyDocument } from '@core/model/types';
import { xy } from '../helpers/xy';

describe('useDrawTool — finishChain with stale closures', () => {
  it('dispatches every collected point when click, click and finish run in one batch', () => {
    const dispatch = vi.fn();
    useStore.setState({ dispatch, document: createEmptyDocument() });
    const { result } = renderHook(() => useDrawTool());
    act(() => result.current.setActiveTool('polyline'));
    const { handleClick, finishChain } = result.current;
    act(() => {
      handleClick([0, 0]);
      handleClick([10, 0]);
      handleClick([10, 10]);
      handleClick([10, 10]); // second click of the double-click
      finishChain();
    });
    expect(dispatch).toHaveBeenCalledWith('draw_polyline', { points: xy(0, 0, 10, 0, 10, 10), closed: false });
    expect(result.current.collectedPoints).toHaveLength(0);
  });
});
