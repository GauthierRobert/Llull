import { describe, it, expect, beforeEach } from 'vitest';
import { useToolStore } from '@ui/store';

describe('useToolStore', () => {
  beforeEach(() => {
    useToolStore.setState({ viewMode: '3d', drawTool: 'none', modifyTool: 'none' });
  });

  it('arming a draw tool shows 2D and disarms the modify tool', () => {
    useToolStore.getState().setModifyTool('trim');
    useToolStore.getState().setDrawTool('circle');
    expect(useToolStore.getState()).toMatchObject({
      viewMode: '2d',
      drawTool: 'circle',
      modifyTool: 'none',
    });
  });

  it('arming a modify tool shows 2D and disarms the draw tool', () => {
    useToolStore.getState().setDrawTool('line');
    useToolStore.getState().setModifyTool('offset');
    expect(useToolStore.getState()).toMatchObject({ drawTool: 'none', modifyTool: 'offset' });
  });

  it('disarming keeps the view; switching to 3D disarms both', () => {
    useToolStore.getState().setDrawTool('line');
    useToolStore.getState().setDrawTool('none');
    expect(useToolStore.getState().viewMode).toBe('2d');
    useToolStore.getState().setModifyTool('fillet');
    useToolStore.getState().setModifyTool('none');
    useToolStore.getState().setModifyTool('fillet');
    useToolStore.getState().setViewMode('3d');
    expect(useToolStore.getState()).toMatchObject({ drawTool: 'none', modifyTool: 'none' });
    useToolStore.getState().setViewMode('2d');
    expect(useToolStore.getState().viewMode).toBe('2d');
  });
});
