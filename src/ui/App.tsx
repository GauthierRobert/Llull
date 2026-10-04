/**
 * @layer ui
 *
 * App shell — the outermost layout component.
 *
 * Layout grid (4 rows):
 *   - Row 0: TopBar — brand, file, workspace tabs, agent status, project + theme actions.
 *   - Row 1: Toolbar — select/transform, 3D solids, 2D drawing, edit actions.
 *   - Row 2: Content — icon-rail Sidebar (document browser panels) docked left,
 *             viewport (with contextual HintBar) in the middle, Properties inspector right.
 *   - Row 3: StatusBar — live-connection indicator, last command, counts, units.
 *
 * The human builds and edits directly (toolbar, viewport, properties) and an MCP agent can
 * drive the same document; both go through the command layer.
 *
 * Theme: reads the active theme from useThemeStore and applies it as
 * `data-theme` on <html> and the root <div> so CSS variables cascade everywhere.
 *
 * View mode (2D / 3D) lives in useToolStore — presentation only, never document
 * state (architecture L7).
 */

import React, { useEffect } from 'react';
import { useLayoutStore, useThemeStore, useToolStore } from '@ui/store';
import { ViewportErrorBoundary } from '@ui/viewport/3d/ViewportErrorBoundary';
import { Viewport3D } from '@ui/viewport/3d/Viewport3D';
import { Viewport2D } from '@ui/viewport/2d/Viewport2D';
import { StatusBar } from '@ui/components/StatusBar';
import { PropertiesPanel } from '@ui/panels/PropertiesPanel';
import { MeasurementHUD } from '@ui/components/MeasurementHUD';
import { EmptyState } from '@ui/components/EmptyState';
import { TopBar } from '@ui/components/TopBar';
import { Sidebar } from '@ui/components/Sidebar';
import { Toolbar } from '@ui/components/toolbar/Toolbar';
import { HintBar } from '@ui/components/HintBar';
import { ShortcutsDialog } from '@ui/components/ShortcutsDialog';
import { CommandPalette } from '@ui/components/commandPalette/CommandPalette';
import { PaletteResultToast } from '@ui/components/commandPalette/PaletteResultToast';
import { Icon } from '@ui/components/Icon';
import { useMcpLiveDocument } from '@ui/hooks/useMcpLiveDocument';
import { useKeyboardShortcuts } from '@ui/hooks/useKeyboardShortcuts';

export function App(): React.ReactElement {
  const theme = useThemeStore((s) => s.theme);
  const inspectorOpen = useLayoutStore((s) => s.inspectorOpen);
  const viewMode = useToolStore((s) => s.viewMode);
  const setViewMode = useToolStore((s) => s.setViewMode);

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
      <Toolbar />

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
              title="3D view (3)"
            >
              <Icon name="cube" size={14} />
              3D
            </button>
            <button
              type="button"
              className={`view-mode-btn${viewMode === '2d' ? ' view-mode-btn--active' : ''}`}
              onClick={() => setViewMode('2d')}
              aria-pressed={viewMode === '2d'}
              title="2D drafting view (2)"
            >
              <Icon name="square" size={14} />
              2D
            </button>
          </div>

          <ViewportErrorBoundary>
            {viewMode === '3d' ? <Viewport3D /> : <Viewport2D />}
          </ViewportErrorBoundary>
          <HintBar />
          <PaletteResultToast />
        </main>

        {inspectorOpen && <PropertiesPanel className="inspector" />}
      </div>

      <StatusBar />
      <ShortcutsDialog />
      <CommandPalette />
    </div>
  );
}
