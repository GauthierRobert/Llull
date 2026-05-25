/**
 * @layer ui
 *
 * App shell — the outermost layout component.
 *
 * Layout grid (3 rows):
 *   - Row 0: Toolbar (generated from the command registry).
 *   - Row 1: Content — properties panel docked left, viewport fills the rest.
 *   - Row 2: StatusBar — units, selection count, last command summary.
 *
 * Theme: reads the active theme from useThemeStore and applies it as
 * `data-theme` on the root <div> so CSS variables cascade to all children.
 * The toggle itself lives inside <StatusBar />.
 *
 * View mode (2D / 3D) is LOCAL React state — presentation only, not in the
 * store (architecture L7: view mode is not document state).
 */

import React, { useState, useEffect, useCallback } from 'react';
import { useThemeStore } from '@ui/store';
import { ViewportErrorBoundary } from '@ui/viewport/3d/ViewportErrorBoundary';
import { Viewport3D } from '@ui/viewport/3d/Viewport3D';
import { Viewport2D } from '@ui/viewport/2d/Viewport2D';
import { Toolbar } from '@ui/components/Toolbar';
import { StatusBar } from '@ui/components/StatusBar';
import { PropertiesPanel } from '@ui/panels/PropertiesPanel';
import { CommandPalette } from '@ui/components/CommandPalette';
import { useKeyboardShortcuts } from '@ui/hooks/useKeyboardShortcuts';

type ViewMode = '3d' | '2d';

export function App(): React.ReactElement {
  const theme = useThemeStore((s) => s.theme);
  const [viewMode, setViewMode] = useState<ViewMode>('3d');
  const [paletteOpen, setPaletteOpen] = useState(false);

  const openPalette = useCallback(() => setPaletteOpen(true), []);
  const closePalette = useCallback(() => setPaletteOpen(false), []);

  // Global keyboard shortcuts: Ctrl+Z undo, Ctrl+Shift+Z/Ctrl+Y redo,
  // Delete → delete_entity, Ctrl/Cmd-K → palette.
  useKeyboardShortcuts({ onOpenPalette: openPalette });

  // Apply the theme as a data attribute on <html> so the CSS variables
  // cascade to the entire document (including portals).
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  return (
    <div className="app-layout" data-theme={theme}>
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
        </div>
      </div>

      <StatusBar />

      {/* Command palette — rendered at the app root so it overlays everything */}
      <CommandPalette isOpen={paletteOpen} onClose={closePalette} />
    </div>
  );
}
