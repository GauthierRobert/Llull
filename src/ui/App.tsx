// App shell (Lens, AI-first): full-bleed viewport; a slim header and the command bar float over it. The browser panel,
// properties, tools and view options appear on demand.

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
import { ViewportContextMenu } from '@ui/components/ViewportContextMenu';
import { HintBar } from '@ui/components/HintBar';
import { ShortcutsDialog } from '@ui/components/ShortcutsDialog';
import { CommandPalette } from '@ui/components/commandPalette/CommandPalette';
import { PaletteResultToast } from '@ui/components/commandPalette/PaletteResultToast';
import { useLiveDocument } from '@ui/hooks/useLiveDocument';
import { useKeyboardShortcuts } from '@ui/hooks/useKeyboardShortcuts';
import { useAutoFrame } from '@ui/hooks/useAutoFrame';
import { useAutosave } from '@ui/hooks/useAutosave';
import { useLiveFx } from '@ui/hooks/useLiveFx';
import { useFocusHousekeeping } from '@ui/hooks/useFocusHousekeeping';
import { SheetViewer } from '@ui/viewport/sheet/SheetViewer';
import { useSheetViewStore } from '@ui/viewport/sheet/sheetViewStore';
import { LiveActivityFeed } from '@ui/components/LiveActivityFeed';
import { RestoredBanner } from '@ui/components/RestoredBanner';

export function App(): React.ReactElement {
  const theme = useThemeStore((s) => s.theme);
  const inspectorOpen = useLayoutStore((s) => s.inspectorOpen);
  const sidebarOpen = useLayoutStore((s) => s.sidebarOpen);
  const viewMode = useToolStore((s) => s.viewMode);
  const openSheetId = useSheetViewStore((s) => s.openSheetId);
  const sheetOpen = useStore((s) => openSheetId !== null && s.document.drawings?.sheets[openSheetId] !== undefined);
  const hasSelection = useStore((s) => s.document.selection.length > 0);
  // Properties float in on demand, and only while something is selected.
  const showInspector = inspectorOpen && hasSelection;

  useLiveDocument();
  useKeyboardShortcuts();
  useAutoFrame();
  useAutosave();
  useLiveFx();
  useFocusHousekeeping();

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
        {!sheetOpen && <ViewportErrorBoundary key={viewMode}>{viewMode === '3d' ? <Viewport3D /> : <Viewport2D />}</ViewportErrorBoundary>}
        <SheetViewer />
        <LiveActivityFeed />
        <HintBar />
        <PaletteResultToast />
        <ViewportContextMenu />
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
