/**
 * Section plane offset: the slider spans -50..50, so an exact number field must reach
 * building-scale offsets (mm models), and must ignore unparseable input.
 */
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
    fireEvent.change(screen.getByLabelText('Exact section distance'), {
      target: { value: '12500' },
    });
    expect(useViewportStore.getState().clipPlane.offset).toBe(12500);
  });

  it('ignores a cleared field', () => {
    render(<ViewportControls />);
    fireEvent.change(screen.getByLabelText('Exact section distance'), {
      target: { value: '' },
    });
    expect(useViewportStore.getState().clipPlane.offset).toBe(0);
  });
});
