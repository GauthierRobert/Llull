import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { useStore, useToolStore } from '@ui/store';
import { useChromeStore } from '@ui/store/chromeStore';
import { ViewOptionsToggle } from '@ui/viewport/3d/ViewOptionsToggle';
import { HintBar } from '@ui/components/HintBar';
import { resetOfflineStore } from '../helpers/storeTestHelpers';

describe('on-demand chrome', () => {
  beforeEach(() => {
    resetOfflineStore();
    useChromeStore.setState({ viewOptionsOpen: false });
    useToolStore.setState({ viewMode: '3d', drawTool: 'none', modifyTool: 'none' });
  });

  it('the view options toggle reveals and hides the 3D view options', () => {
    render(<ViewOptionsToggle />);
    fireEvent.click(screen.getByRole('button', { name: 'Show view options' }));
    expect(useChromeStore.getState().viewOptionsOpen).toBe(true);
    expect(screen.getByRole('button', { name: 'Hide view options' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Hide view options' }));
    expect(useChromeStore.getState().viewOptionsOpen).toBe(false);
  });

  it('the hint bar stays out of sight until a tool is in hand', () => {
    useStore.getState().dispatch('add_box', { size: [1, 1, 1] });
    const { rerender } = render(<HintBar />);
    expect(screen.queryByRole('status', { name: 'Hint' })).toBeNull();
    useToolStore.setState({ viewMode: '2d', drawTool: 'rectangle' });
    rerender(<HintBar />);
    expect(screen.getByRole('status', { name: 'Hint' })).toHaveTextContent(/corner/i);
  });
});
