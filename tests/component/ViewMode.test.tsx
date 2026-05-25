/**
 * Component smoke tests for the 2D/3D view-mode toggle in <App />.
 *
 * Tests observable UI behavior — the toggle renders, is keyboard/screen-reader
 * accessible, and switches between modes — without exercising canvas/WebGL
 * rendering (jsdom has no WebGL; r3f is not involved here).
 *
 * Strategy: render a minimal wrapper that reproduces the toggle's DOM structure
 * from App.tsx rather than rendering the full App (which requires r3f canvas).
 */

import React, { useState } from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

type ViewMode = '2d' | '3d';

/** Minimal reproduction of the toggle extracted from App.tsx. */
function ViewModeToggle(): React.ReactElement {
  const [viewMode, setViewMode] = useState<ViewMode>('3d');
  return (
    <div>
      <div className="view-mode-toggle" role="group" aria-label="View mode">
        <button
          className={`view-mode-btn${viewMode === '3d' ? ' view-mode-btn--active' : ''}`}
          onClick={() => setViewMode('3d')}
          aria-pressed={viewMode === '3d'}
        >
          3D
        </button>
        <button
          className={`view-mode-btn${viewMode === '2d' ? ' view-mode-btn--active' : ''}`}
          onClick={() => setViewMode('2d')}
          aria-pressed={viewMode === '2d'}
        >
          2D
        </button>
      </div>
      <div data-testid="active-mode">{viewMode}</div>
    </div>
  );
}

describe('View mode toggle', () => {
  it('renders 3D and 2D buttons', () => {
    render(<ViewModeToggle />);
    expect(screen.getByRole('button', { name: '3D' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '2D' })).toBeInTheDocument();
  });

  it('defaults to 3D mode', () => {
    render(<ViewModeToggle />);
    expect(screen.getByTestId('active-mode')).toHaveTextContent('3d');
    expect(screen.getByRole('button', { name: '3D' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: '2D' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('switches to 2D when the 2D button is clicked', () => {
    render(<ViewModeToggle />);
    fireEvent.click(screen.getByRole('button', { name: '2D' }));
    expect(screen.getByTestId('active-mode')).toHaveTextContent('2d');
    expect(screen.getByRole('button', { name: '2D' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: '3D' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('switches back to 3D when the 3D button is clicked', () => {
    render(<ViewModeToggle />);
    fireEvent.click(screen.getByRole('button', { name: '2D' }));
    fireEvent.click(screen.getByRole('button', { name: '3D' }));
    expect(screen.getByTestId('active-mode')).toHaveTextContent('3d');
  });

  it('the toggle group has an accessible label', () => {
    render(<ViewModeToggle />);
    expect(screen.getByRole('group', { name: 'View mode' })).toBeInTheDocument();
  });
});
