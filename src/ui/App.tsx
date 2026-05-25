/**
 * @layer ui
 *
 * App shell — the outermost layout component.
 *
 * Layout grid:
 *   - Toolbar row at the top (generated from the command registry — E1).
 *   - Viewport fills the remaining space.
 *   - Right-side panel region reserved for future panel slot (E2 / F3).
 *
 * The component is purely structural: it composes the toolbar, viewport,
 * error boundary, and a minimal status bar. No document mutations happen here.
 *
 * View mode (2D / 3D) is LOCAL React state — presentation only, not in the
 * store (architecture L7: view mode is not document state).
 */

import React, { useState } from 'react';
import { useStore } from '@ui/store';
import { ViewportErrorBoundary } from '@ui/viewport/3d/ViewportErrorBoundary';
import { Viewport3D } from '@ui/viewport/3d/Viewport3D';
import { Viewport2D } from '@ui/viewport/2d/Viewport2D';
import { Toolbar } from '@ui/components/Toolbar';
import { PropertiesPanel } from '@ui/panels/PropertiesPanel';

type ViewMode = '3d' | '2d';

export function App(): React.ReactElement {
  const lastSummary = useStore((s) => s.lastSummary);
  const [viewMode, setViewMode] = useState<ViewMode>('3d');

  return (
    <div className="app-layout">
      <Toolbar />

      <div className="app-content">
        {/* Properties panel (E2): left dock — selection + param-form command runner. */}
        <PropertiesPanel className="app-properties" />

        <div className="app-viewport">
          {/* 2D / 3D view mode toggle — positioned over the viewport */}
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

          <ViewportErrorBoundary>
            {viewMode === '3d' ? <Viewport3D /> : <Viewport2D />}
          </ViewportErrorBoundary>

          {lastSummary !== null && (
            <div className="status-bar" role="status" aria-live="polite">
              {lastSummary}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
