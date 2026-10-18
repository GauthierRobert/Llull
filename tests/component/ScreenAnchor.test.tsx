import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { ScreenAnchorOverlay } from '@ui/viewport/screenAnchor/ScreenAnchorOverlay';
import { forgetAnchor, placeAnchor, useScreenAnchorStore } from '@ui/viewport/screenAnchor/screenAnchorStore';
import { anchorTransform, ndcToScreenPoint } from '@ui/viewport/screenAnchor/screenPoint';

afterEach(() => {
  act(() => useScreenAnchorStore.getState().remove('badge'));
  forgetAnchor('badge');
  vi.restoreAllMocks();
});

describe('ndcToScreenPoint', () => {
  it('maps NDC to canvas pixels with y flipped and flags points outside the depth range', () => {
    expect(ndcToScreenPoint(0, 0, 0, 800, 600)).toEqual({ x: 400, y: 300, visible: true });
    expect(ndcToScreenPoint(-1, 1, 0.5, 800, 600)).toEqual({ x: 0, y: 0, visible: true });
    expect(ndcToScreenPoint(0, 0, 1.2, 800, 600).visible).toBe(false);
    expect(ndcToScreenPoint(0, 0, Number.NaN, 800, 600).visible).toBe(false);
  });

  it('builds a centred or corner-anchored transform', () => {
    const point = { x: 10, y: 20, visible: true };
    expect(anchorTransform(point, false)).toBe('translate3d(10.0px, 20.0px, 0)');
    expect(anchorTransform(point, true)).toBe('translate3d(10.0px, 20.0px, 0) translate(-50%, -50%)');
  });
});

describe('ScreenAnchorOverlay', () => {
  it('renders anchored labels as plain DOM (no nested React root) and positions them from projected points', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(<ScreenAnchorOverlay />);
    act(() => {
      useScreenAnchorStore.getState().upsert({ id: 'badge', content: <span>agent edit</span>, centered: true, zIndex: 20, className: '' });
    });
    const label = screen.getByText('agent edit').parentElement;
    expect(label).not.toBeNull();
    act(() => placeAnchor('badge', { x: 120, y: 80, visible: true }, true));
    expect(label?.style.transform).toBe('translate3d(120.0px, 80.0px, 0) translate(-50%, -50%)');
    expect(label?.style.visibility).toBe('visible');
    act(() => placeAnchor('badge', { x: 0, y: 0, visible: false }, true));
    expect(label?.style.visibility).toBe('hidden');
    act(() => useScreenAnchorStore.getState().remove('badge'));
    expect(screen.queryByText('agent edit')).toBeNull();
    expect(errors).not.toHaveBeenCalled();
  });
});
