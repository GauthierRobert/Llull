import { describe, it, expect, vi, afterEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ViewportErrorBoundary } from '@ui/viewport/3d/ViewportErrorBoundary';

let shouldThrow = true;
function Bomb(): React.ReactElement {
  if (shouldThrow) throw new Error('boom');
  return <p>scene ok</p>;
}

describe('ViewportErrorBoundary', () => {
  afterEach(() => vi.restoreAllMocks());
  it('shows the fallback and Retry re-renders the children', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    shouldThrow = true;
    render(
      <ViewportErrorBoundary>
        <Bomb />
      </ViewportErrorBoundary>,
    );
    expect(screen.getByRole('alert').textContent).toContain('boom');
    shouldThrow = false;
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(screen.getByText('scene ok')).toBeDefined();
  });
  it('a new key (view mode switch) resets the error state', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    shouldThrow = true;
    const { rerender } = render(
      <ViewportErrorBoundary key="3d">
        <Bomb />
      </ViewportErrorBoundary>,
    );
    shouldThrow = false;
    rerender(
      <ViewportErrorBoundary key="2d">
        <Bomb />
      </ViewportErrorBoundary>,
    );
    expect(screen.getByText('scene ok')).toBeDefined();
  });
});
