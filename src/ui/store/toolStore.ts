/**
 * @layer ui/store
 *
 * Tool store — which view is shown, which 2D draw tool is armed, which 3D transform
 * gizmo mode is active, and whether the shortcut sheet is open. Shared by the main
 * toolbar, the keyboard shortcuts, the hint bar and both viewports.
 * Presentation-only state; never part of CadDocument (architecture L7).
 */

import { create } from 'zustand';

export type ViewMode = '3d' | '2d';

export type DrawToolKind =
  | 'none'
  | 'move'
  | 'line'
  | 'polyline'
  | 'wall'
  | 'circle'
  | 'rectangle'
  | 'point'
  | 'ellipse'
  | 'spline';

export type GizmoMode = 'translate' | 'rotate' | 'scale';

export interface ToolStoreState {
  viewMode: ViewMode;
  /** Armed 2D tool; only meaningful in the 2D view. */
  drawTool: DrawToolKind;
  gizmoMode: GizmoMode;
  shortcutsOpen: boolean;
  setViewMode(viewMode: ViewMode): void;
  /** Arm a 2D tool; arming any tool other than 'none' switches to the 2D view. */
  setDrawTool(drawTool: DrawToolKind): void;
  setGizmoMode(gizmoMode: GizmoMode): void;
  setShortcutsOpen(shortcutsOpen: boolean): void;
}

export const useToolStore = create<ToolStoreState>()((set) => ({
  viewMode: '3d',
  drawTool: 'none',
  gizmoMode: 'translate',
  shortcutsOpen: false,

  setViewMode(viewMode: ViewMode): void {
    set(viewMode === '3d' ? { viewMode, drawTool: 'none' } : { viewMode });
  },

  setDrawTool(drawTool: DrawToolKind): void {
    set(drawTool === 'none' ? { drawTool } : { drawTool, viewMode: '2d' });
  },

  setGizmoMode(gizmoMode: GizmoMode): void {
    set({ gizmoMode });
  },

  setShortcutsOpen(shortcutsOpen: boolean): void {
    set({ shortcutsOpen });
  },
}));
