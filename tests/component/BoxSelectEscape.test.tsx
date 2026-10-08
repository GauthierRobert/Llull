/** Esc during a Shift+drag box cancels it: releasing the pointer selects nothing. */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, act, fireEvent } from '@testing-library/react';
import { useStore } from '@ui/store';
import { createEmptyDocument } from '@core/model/types';
import type { Vec2 } from '@core/model/types';
import { execute } from '@core/commands/registry';

const captured = vi.hoisted(() => ({ handlers: {} as Record<string, (event: unknown) => void> }));

vi.mock('@ui/viewport/2d/GroundPlane', () => ({
  GroundPlane: (props: Record<string, (event: unknown) => void>) => {
    captured.handlers = props;
    return null;
  },
  toDocumentPoint: (hit: { x: number; y: number }): Vec2 => [hit.x, hit.y],
}));

import { BoxSelectInteraction } from '@ui/viewport/2d/BoxSelectInteraction';

const pointer = (x: number, y: number): unknown => ({ point: { x, y }, shiftKey: true });

describe('BoxSelectInteraction — Esc', () => {
  const select = vi.fn();
  beforeEach(() => {
    select.mockClear();
    const drawn = execute(createEmptyDocument(), 'draw_circle', { center: [2, 2], radius: 1 });
    useStore.setState({ document: drawn.document, select });
  });

  const drag = (escape: boolean): void => {
    render(<BoxSelectInteraction zoom={50} />);
    act(() => captured.handlers['onPointerDown']?.(pointer(0, 0)));
    act(() => captured.handlers['onPointerMove']?.(pointer(5, 5)));
    if (escape) act(() => void fireEvent.keyDown(window, { key: 'Escape' }));
    act(() => captured.handlers['onPointerUp']?.(pointer(5, 5)));
  };

  it('selects the enclosed entities on release', () => {
    drag(false);
    expect(select).toHaveBeenCalledTimes(1);
  });

  it('selects nothing when Esc is pressed mid-drag', () => {
    drag(true);
    expect(select).not.toHaveBeenCalled();
  });
});
