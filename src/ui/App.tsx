// App shell (Lens): full-bleed viewport; header, browser rail, inspector card, tool dock and status float over it.

import React, { useEffect } from 'react';
import { useLayoutStore, useStore, useThemeStore, useToolStore } from '@ui/store';
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
import { useMcpLiveDocument } from '@ui/hooks/useMcpLiveDocument';
import { useKeyboardShortcuts } from '@ui/hooks/useKeyboardShortcuts';
import { useAutoFrame } from '@ui/hooks/useAutoFrame';
import { useAutosave } from '@ui/hooks/useAutosave';
import { useLiveFx } from '@ui/hooks/useLiveFx';
import { LiveActivityFeed } from '@ui/components/LiveActivityFeed';
import { RestoredBanner } from '@ui/components/RestoredBanner';
import { UpdateBanner } from '@ui/components/UpdateBanner';

export function App(): React.ReactElement {
  const theme = useThemeStore((s) => s.theme);
  const inspectorOpen = useLayoutStore((s) => s.inspectorOpen);
  const sidebarOpen = useLayoutStore((s) => s.sidebarOpen);
  const viewMode = useToolStore((s) => s.viewMode);
  const hasSelection = useStore((s) => s.document.selection.length > 0);
  // Lens: properties float in only while something is selected.
  const showInspector = inspectorOpen && hasSelection;

  useMcpLiveDocument();
  useKeyboardShortcuts();
  useAutoFrame();
  useAutosave();
  useLiveFx();

  // On <html> so CSS variables cascade to portals.
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  return (
    <div
      className="app-layout"
      data-theme={theme}
      data-sidebar={sidebarOpen ? 'open' : 'closed'}
      data-inspector={showInspector ? 'open' : 'closed'}
    >
      <main className="app-viewport" aria-label="Viewport">
        <MeasurementHUD />
        <EmptyState />
        <RestoredBanner />
        <UpdateBanner />
        <ViewportErrorBoundary key={viewMode}>{viewMode === '3d' ? <Viewport3D /> : <Viewport2D />}</ViewportErrorBoundary>
        <LiveActivityFeed />
        <HintBar />
        <PaletteResultToast />
      </main>

      <TopBar />
      <Sidebar />
      {showInspector && <PropertiesPanel className="inspector" />}
      <Toolbar />
      <StatusBar />
      <ShortcutsDialog />
      <CommandPalette />
    </div>
  );
}
