/** Fillet/chamfer vertex pick must stay on the polyline chosen in the first pick. */
import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useStore, useToolStore } from '@ui/store';
import { createEmptyDocument } from '@core/model/types';
import { useModifyTool } from '../../src/ui/viewport/2d/useModifyTool';

const POLY: Array<[number, number]> = [
  [0, 0],
  [10, 0],
  [10, 10],
];

describe('useModifyTool — vertex pick', () => {
  beforeEach(() => {
    useToolStore.setState({ viewMode: '2d', drawTool: 'none', modifyTool: 'none' });
    useStore.setState({ document: createEmptyDocument(), lastSummary: null });
  });

  it('ignores a vertex-phase click that lands on a different entity', () => {
    const { result } = renderHook(() => useModifyTool());
    act(() => result.current.setActiveTool('fillet'));
    act(() => result.current.handleEntityPick('poly-1', [0, 0], POLY));
    expect(result.current.phase).toBe('pick-vertex');

    act(() => result.current.handleEntityPick('poly-2', [9.5, 0.5], POLY));
    expect(result.current.phase).toBe('pick-vertex');
    expect(result.current.pickedVertexIndex).toBeNull();

    act(() => result.current.handleEntityPick('poly-1', [9.5, 0.5], POLY));
    expect(result.current.phase).toBe('enter-value');
    expect(result.current.pickedVertexIndex).toBe(1);
  });
});
