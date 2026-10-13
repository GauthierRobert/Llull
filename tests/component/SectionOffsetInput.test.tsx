import { describe, it, expect, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { useViewportStore } from '@ui/store';
import { ViewportControls } from '@ui/viewport/3d/ViewportControls';

describe('Section plane exact offset', () => {
  beforeEach(() => {
    useViewportStore.getState().setClipPlane({ enabled: true, offset: 0 });
  });
  it('sets offsets beyond the slider range', () => {
    render(<ViewportControls />);
    fireEvent.change(screen.getByLabelText('Exact section distance'), { target: { value: '12500' } });
    expect(useViewportStore.getState().clipPlane.offset).toBe(12500);
  });
  it('ignores a cleared field', () => {
    render(<ViewportControls />);
    fireEvent.change(screen.getByLabelText('Exact section distance'), { target: { value: '' } });
    expect(useViewportStore.getState().clipPlane.offset).toBe(0);
  });
});
