/** Holding Shift while drafting constrains the snapped cursor to the axis from the last point. */
import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useStore } from '@ui/store';
import { createEmptyDocument } from '@core/model/types';
import { useZoomSnap } from '@ui/viewport/2d/useSnap';

describe('useZoomSnap — ortho', () => {
  it('keeps the cursor on the horizontal/vertical from the draw origin when ortho is on', () => {
    useStore.setState({ document: createEmptyDocument() });
    const horizontal = renderHook(() => useZoomSnap([9.7, 1.3], 50, [0, 0], true));
    expect(horizontal.result.current?.y).toBeCloseTo(0);
    const vertical = renderHook(() => useZoomSnap([1.3, 9.7], 50, [0, 0], true));
    expect(vertical.result.current?.x).toBeCloseTo(0);
  });

  it('leaves the cursor free when ortho is off', () => {
    useStore.setState({ document: createEmptyDocument() });
    const free = renderHook(() => useZoomSnap([9.7, 1.3], 50, [0, 0], false));
    expect(free.result.current?.y).not.toBeCloseTo(0);
  });
});
