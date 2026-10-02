/**
 * @layer ui/store
 *
 * Tool store — which view is shown, which 2D draw or modify tool is armed (at most one),
 * which 3D transform gizmo mode is active, and whether the shortcut sheet is open. Shared by the main
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

export type ModifyToolKind =
  | 'none'
  | 'offset'
  | 'fillet'
  | 'chamfer'
  | 'trim'
  | 'extend'
  | 'explode';

export type GizmoMode = 'translate' | 'rotate' | 'scale';

export interface ToolStoreState {
  viewMode: ViewMode;
  /** Armed 2D tool; only meaningful in the 2D view. */
  drawTool: DrawToolKind;
  /** Armed 2D modify tool; mutually exclusive with drawTool. */
  modifyTool: ModifyToolKind;
  gizmoMode: GizmoMode;
  shortcutsOpen: boolean;
  setViewMode(viewMode: ViewMode): void;
  /** Arm a 2D draw tool; arming any tool other than 'none' disarms the modify tool and shows 2D. */
  setDrawTool(drawTool: DrawToolKind): void;
  /** Arm a 2D modify tool; arming any tool other than 'none' disarms the draw tool and shows 2D. */
  setModifyTool(modifyTool: ModifyToolKind): void;
  setGizmoMode(gizmoMode: GizmoMode): void;
  setShortcutsOpen(shortcutsOpen: boolean): void;
}

export const useToolStore = create<ToolStoreState>()((set) => ({
  viewMode: '3d',
  drawTool: 'none',
  modifyTool: 'none',
  gizmoMode: 'translate',
  shortcutsOpen: false,

  setViewMode(viewMode: ViewMode): void {
    set(viewMode === '3d' ? { viewMode, drawTool: 'none', modifyTool: 'none' } : { viewMode });
  },

  setDrawTool(drawTool: DrawToolKind): void {
    set(drawTool === 'none' ? { drawTool } : { drawTool, modifyTool: 'none', viewMode: '2d' });
  },

  setModifyTool(modifyTool: ModifyToolKind): void {
    set(modifyTool === 'none' ? { modifyTool } : { modifyTool, drawTool: 'none', viewMode: '2d' });
  },

  setGizmoMode(gizmoMode: GizmoMode): void {
    set({ gizmoMode });
  },

  setShortcutsOpen(shortcutsOpen: boolean): void {
    set({ shortcutsOpen });
  },
}));
