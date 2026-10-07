/**
 * @layer ui
 *
 * App shell: top bar, toolbar, content row (sidebar | viewport with hint bar | inspector), status
 * bar. View mode (2D / 3D) lives in useToolStore (architecture L7); the theme is mirrored to
 * `data-theme` on <html> so portals inherit it. Edits go through the command layer.
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
import { useAutoFrame } from '@ui/hooks/useAutoFrame';
import { useAutosave } from '@ui/hooks/useAutosave';
import { RestoredBanner } from '@ui/components/RestoredBanner';

export function App(): React.ReactElement {
  const theme = useThemeStore((s) => s.theme);
  const inspectorOpen = useLayoutStore((s) => s.inspectorOpen);
  const viewMode = useToolStore((s) => s.viewMode);
  const setViewMode = useToolStore((s) => s.setViewMode);

  // Mirror the server-authoritative CadDocument into the store via SSE.
  useMcpLiveDocument();
  useKeyboardShortcuts();
  useAutoFrame();
  useAutosave();

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
          <RestoredBanner />

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
