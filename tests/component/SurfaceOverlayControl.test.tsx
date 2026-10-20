import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ViewportControls } from '@ui/viewport/3d/ViewportControls';
import { useSurfaceOverlayStore } from '@ui/store/surfaceOverlayStore';
import { resetViewportStores } from '../helpers/componentEntities';

describe('ViewportControls - surface analysis overlay', () => {
  beforeEach(() => {
    resetViewportStores({ qualityOverride: 'auto' });
    useSurfaceOverlayStore.setState({ map: 'off', comb: false, direction: [0, 0, 1] });
  });

  it('offers Off, Gaussian, Mean, Zebra and Draft and starts with Off', () => {
    render(<ViewportControls />);
    const select = screen.getByLabelText('Surface map') as HTMLSelectElement;
    expect(select.value).toBe('off');
    expect(Array.from(select.options).map((o) => o.value)).toEqual(['off', 'gaussian', 'mean', 'zebra', 'draft']);
  });

  it('choosing a map updates the overlay store', () => {
    render(<ViewportControls />);
    fireEvent.change(screen.getByLabelText('Surface map'), { target: { value: 'zebra' } });
    expect(useSurfaceOverlayStore.getState().map).toBe('zebra');
  });

  it('the comb button toggles the curvature comb and reports its state', () => {
    render(<ViewportControls />);
    const button = screen.getByLabelText('Curvature comb');
    expect(button.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(button);
    expect(useSurfaceOverlayStore.getState().comb).toBe(true);
    expect(screen.getByLabelText('Curvature comb').getAttribute('aria-pressed')).toBe('true');
  });

  it('the direction setter replaces the zebra / draft direction', () => {
    useSurfaceOverlayStore.getState().setDirection([1, 0, 0]);
    expect(useSurfaceOverlayStore.getState().direction).toEqual([1, 0, 0]);
  });
});
