/**
 * @layer ui
 *
 * App shell — the outermost layout component.
 *
 * Layout grid (2 rows):
 *   - Row 0: Content — properties panel docked left, viewport fills the rest,
 *             layers panel docked right.
 *   - Row 1: StatusBar — live-connection indicator, units, selection count.
 *
 * llull is now a LIVE READ-ONLY VIEWER of the MCP-driven document.
 * Claude drives the model over MCP; the human watches it render and adjusts by
 * re-instructing Claude. The Toolbar and CommandPalette are removed — document
 * mutations come exclusively from MCP agents, not UI controls.
 *
 * Theme: reads the active theme from useThemeStore and applies it as
 * `data-theme` on the root <div> so CSS variables cascade to all children.
 * The toggle itself lives inside <StatusBar />.
 *
 * View mode (2D / 3D) is LOCAL React state — presentation only, not in the
 * store (architecture L7: view mode is not document state).
 */

import React, { useState, useEffect } from 'react';
import { useThemeStore } from '@ui/store';
import { ViewportErrorBoundary } from '@ui/viewport/3d/ViewportErrorBoundary';
import { Viewport3D } from '@ui/viewport/3d/Viewport3D';
import { Viewport2D } from '@ui/viewport/2d/Viewport2D';
import { StatusBar } from '@ui/components/StatusBar';
import { PropertiesPanel } from '@ui/panels/PropertiesPanel';
import { LayersPanel } from '@ui/panels/LayersPanel';
import { ParametersPanel } from '@ui/panels/ParametersPanel';
import { FeatureHistoryPanel } from '@ui/panels/FeatureHistoryPanel';
import { ConfigurationsPanel } from '@ui/panels/ConfigurationsPanel';
import { MaterialsPanel } from '@ui/panels/MaterialsPanel';
import { MeasurementHUD } from '@ui/components/MeasurementHUD';
import { EmptyState } from '@ui/components/EmptyState';
import { TopBar } from '@ui/components/TopBar';
import { useMcpLiveDocument } from '@ui/hooks/useMcpLiveDocument';

type ViewMode = '3d' | '2d';

export function App(): React.ReactElement {
  const theme = useThemeStore((s) => s.theme);
  const [viewMode, setViewMode] = useState<ViewMode>('3d');

  // Mirror the server-authoritative CadDocument into the store via SSE.
  useMcpLiveDocument();

  // Apply the theme as a data attribute on <html> so the CSS variables
  // cascade to the entire document (including portals).
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  return (
    <div className="app-layout" data-theme={theme}>
      <TopBar />

      <div className="app-content">
        {/* Properties panel: left dock — read-only entity inspector. */}
        <PropertiesPanel className="app-properties" />

        <div className="app-viewport">
          {/* Measurement HUD — overlays both 2D and 3D viewports; positioned bottom-left */}
          <MeasurementHUD />

          {/* Empty-state hint — shown when the document has no entities */}
          <EmptyState />

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

        {/* Right dock — layers, parameters, feature history, and configurations panels stacked */}
        <div className="app-right-dock">
          <LayersPanel className="app-layers-inner" />
          <ParametersPanel className="app-params-inner" />
          <FeatureHistoryPanel className="app-history-inner" />
          <ConfigurationsPanel className="app-configs-inner" />
          <MaterialsPanel className="app-materials-inner" />
        </div>
      </div>

      <StatusBar />
    </div>
  );
}
