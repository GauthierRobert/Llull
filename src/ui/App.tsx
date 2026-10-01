/**
 * @layer ui
 *
 * App shell — the outermost layout component.
 *
 * Layout grid (3 rows):
 *   - Row 0: TopBar — brand, file, workspace tabs, agent status, project + theme actions.
 *   - Row 1: Content — icon-rail Sidebar (document browser panels) docked left,
 *             viewport fills the middle, Properties inspector docked right.
 *   - Row 2: StatusBar — live-connection indicator, last command, counts, units.
 *
 * llull is a LIVE VIEWER of the MCP-driven document: Claude drives the model over
 * MCP; the human watches it render and adjusts by re-instructing Claude.
 *
 * Theme: reads the active theme from useThemeStore and applies it as
 * `data-theme` on <html> and the root <div> so CSS variables cascade everywhere.
 *
 * View mode (2D / 3D) is LOCAL React state — presentation only, not in the
 * store (architecture L7: view mode is not document state).
 */

import React, { useState, useEffect } from 'react';
import { useLayoutStore, useThemeStore } from '@ui/store';
import { ViewportErrorBoundary } from '@ui/viewport/3d/ViewportErrorBoundary';
import { Viewport3D } from '@ui/viewport/3d/Viewport3D';
import { Viewport2D } from '@ui/viewport/2d/Viewport2D';
import { StatusBar } from '@ui/components/StatusBar';
import { PropertiesPanel } from '@ui/panels/PropertiesPanel';
import { MeasurementHUD } from '@ui/components/MeasurementHUD';
import { EmptyState } from '@ui/components/EmptyState';
import { TopBar } from '@ui/components/TopBar';
import { Sidebar } from '@ui/components/Sidebar';
import { Icon } from '@ui/components/Icon';
import { useMcpLiveDocument } from '@ui/hooks/useMcpLiveDocument';
import { useKeyboardShortcuts } from '@ui/hooks/useKeyboardShortcuts';

type ViewMode = '3d' | '2d';

export function App(): React.ReactElement {
  const theme = useThemeStore((s) => s.theme);
  const inspectorOpen = useLayoutStore((s) => s.inspectorOpen);
  const [viewMode, setViewMode] = useState<ViewMode>('3d');

  // Mirror the server-authoritative CadDocument into the store via SSE.
  useMcpLiveDocument();
  useKeyboardShortcuts();

  // Apply the theme on <html> so CSS variables cascade to portals too.
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  return (
    <div className="app-layout" data-theme={theme}>
      <TopBar />

      <div className="app-content">
        <Sidebar />

        <main className="app-viewport" aria-label="Viewport">
          <MeasurementHUD />
          <EmptyState />

          <div className="view-mode-toggle" role="group" aria-label="View mode">
            <button
              type="button"
              className={`view-mode-btn${viewMode === '3d' ? ' view-mode-btn--active' : ''}`}
              onClick={() => setViewMode('3d')}
              aria-pressed={viewMode === '3d'}
            >
              <Icon name="cube" size={14} />
              3D
            </button>
            <button
              type="button"
              className={`view-mode-btn${viewMode === '2d' ? ' view-mode-btn--active' : ''}`}
              onClick={() => setViewMode('2d')}
              aria-pressed={viewMode === '2d'}
            >
              <Icon name="square" size={14} />
              2D
            </button>
          </div>

          <ViewportErrorBoundary>
            {viewMode === '3d' ? <Viewport3D /> : <Viewport2D />}
          </ViewportErrorBoundary>
        </main>

        {inspectorOpen && <PropertiesPanel className="inspector" />}
      </div>

      <StatusBar />
    </div>
  );
}
