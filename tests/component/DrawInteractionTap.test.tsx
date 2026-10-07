/** A tap/click with no preceding pointermove must land at the pressed point, not the last hover. */
import { describe, it, expect, vi } from 'vitest';
import { render, act } from '@testing-library/react';
import type { Vec2 } from '@core/model/types';

const captured = vi.hoisted(() => ({ handlers: {} as Record<string, (event: unknown) => void> }));

vi.mock('@ui/viewport/2d/GroundPlane', () => ({
  GroundPlane: (props: Record<string, (event: unknown) => void>) => {
    captured.handlers = props;
    return null;
  },
  toDocumentPoint: (hit: { x: number; y: number }): Vec2 => [hit.x, hit.y],
}));
vi.mock('@ui/viewport/2d/useSnap', () => ({
  useZoomSnap: (cursor: Vec2 | null) => (cursor ? { x: cursor[0], y: cursor[1] } : null),
}));
vi.mock('@ui/viewport/2d/DrawPreview', () => ({
  DrawPreview: () => null,
  CollectedPointMarkers: () => null,
}));

import { DrawInteraction } from '@ui/viewport/2d/DrawInteraction';

const pointer = (x: number, y: number): unknown => ({
  point: { x, y },
  shiftKey: false,
  stopPropagation: () => undefined,
});

describe('DrawInteraction — tap without hover', () => {
  it('uses the pressed point rather than the previous hover position', () => {
    const onClickPoint = vi.fn();
    render(
      <DrawInteraction
        activeTool="line"
        collectedPoints={[]}
        onClickPoint={onClickPoint}
        onDoubleClick={vi.fn()}
        zoom={50}
      />,
    );
    act(() => captured.handlers['onPointerMove']?.(pointer(1, 1)));
    act(() => captured.handlers['onPointerDown']?.(pointer(5, 5)));
    act(() => captured.handlers['onClick']?.(pointer(5, 5)));
    expect(onClickPoint).toHaveBeenCalledWith([5, 5]);
  });
});
