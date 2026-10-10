/**
 * A tap/click with no preceding pointermove must land at the pressed point, not the last hover;
 * a press updates the cursor synchronously (flushSync) so a same-frame tap click is not stale.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, act } from '@testing-library/react';
import type { Vec2 } from '@core/model/types';

const captured = vi.hoisted(() => ({
  handlers: {} as Record<string, (event: unknown) => void>,
  flushSync: vi.fn((fn: () => void) => fn()),
}));

vi.mock('@react-three/fiber', () => ({ flushSync: captured.flushSync }));
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

function renderLine(onClickPoint = vi.fn()): ReturnType<typeof vi.fn> {
  render(
    <DrawInteraction
      activeTool="line"
      collectedPoints={[]}
      onClickPoint={onClickPoint}
      onDoubleClick={vi.fn()}
      zoom={50}
    />,
  );
  return onClickPoint;
}

describe('DrawInteraction — tap without hover', () => {
  it('uses the pressed point rather than the previous hover position', () => {
    const onClickPoint = renderLine();
    act(() => captured.handlers['onPointerMove']?.(pointer(1, 1)));
    act(() => captured.handlers['onPointerDown']?.(pointer(5, 5)));
    act(() => captured.handlers['onClick']?.(pointer(5, 5)));
    expect(onClickPoint).toHaveBeenCalledWith([5, 5]);
  });
});

describe('DrawInteraction — synchronous press', () => {
  it('flushes the cursor update on pointer down', () => {
    captured.flushSync.mockClear();
    renderLine();
    act(() => captured.handlers['onPointerDown']?.({ point: { x: 3, y: 4 }, shiftKey: false }));
    expect(captured.flushSync).toHaveBeenCalledTimes(1);
  });
});
