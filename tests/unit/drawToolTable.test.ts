import { describe, expect, it, vi } from 'vitest';
import { drawToolDescriptor, isChainTool } from '@ui/viewport/2d/drawToolTable';
import { xy } from '../helpers/xy';

describe('draw tool descriptor table', () => {
  it('classifies chain tools by maxPoints null; line is a 2-point polyline mode', () => {
    expect(['polyline', 'wall', 'spline'].every((t) => isChainTool(t as 'wall'))).toBe(true);
    expect(isChainTool('line')).toBe(false);
    expect(drawToolDescriptor('line')?.maxPoints).toBe(2);
    expect(drawToolDescriptor('point')?.maxPoints).toBe(1);
    expect(drawToolDescriptor('none')).toBeUndefined();
  });
  it('line commits draw_polyline with both points', () => {
    const dispatch = vi.fn();
    drawToolDescriptor('line')?.commit(xy(0, 0, 3, 4), dispatch);
    expect(dispatch).toHaveBeenCalledWith('draw_polyline', { points: xy(0, 0, 3, 4) });
  });
  it('chains drop repeated points and need two distinct ones', () => {
    const dispatch = vi.fn();
    drawToolDescriptor('spline')?.commit(xy(0, 0, 0, 0), dispatch);
    expect(dispatch).not.toHaveBeenCalled();
    drawToolDescriptor('polyline')?.commit(xy(0, 0, 5, 0, 5, 0), dispatch);
    expect(dispatch).toHaveBeenCalledWith('draw_polyline', { points: xy(0, 0, 5, 0), closed: false });
  });
  it('degenerate two-click shapes dispatch nothing; circle previews an outline', () => {
    const dispatch = vi.fn();
    drawToolDescriptor('circle')?.commit(xy(1, 1, 1, 1), dispatch);
    expect(dispatch).not.toHaveBeenCalled();
    const preview = drawToolDescriptor('circle')?.preview;
    expect(typeof preview === 'function' && preview([0, 0], [1, 0])?.length).toBeGreaterThan(0);
  });
});
