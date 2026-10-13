// Presentation-only tool state: shown view, armed 2D draw OR modify tool, gizmo mode, shortcut sheet.

import { create } from 'zustand';

export type ViewMode = '3d' | '2d';

export type DrawToolKind = 'none' | 'move' | 'line' | 'polyline' | 'wall' | 'circle' | 'rectangle' | 'point' | 'ellipse' | 'spline';

export type ModifyToolKind = 'none' | 'offset' | 'fillet' | 'chamfer' | 'trim' | 'extend' | 'explode';

export type GizmoMode = 'translate' | 'rotate' | 'scale';

interface ToolStoreState {
  viewMode: ViewMode;
  /** Only meaningful in 2D. */
  drawTool: DrawToolKind;
  /** Mutually exclusive with drawTool. */
  modifyTool: ModifyToolKind;
  gizmoMode: GizmoMode;
  shortcutsOpen: boolean;
  setViewMode(viewMode: ViewMode): void;
  /** Arming anything but 'none' disarms the modify tool and shows 2D. */
  setDrawTool(drawTool: DrawToolKind): void;
  /** Disarms when already armed. */
  toggleDrawTool(drawTool: DrawToolKind): void;
  /** Arming anything but 'none' disarms the draw tool and shows 2D. */
  setModifyTool(modifyTool: ModifyToolKind): void;
  setGizmoMode(gizmoMode: GizmoMode): void;
  setShortcutsOpen(shortcutsOpen: boolean): void;
}

export const useToolStore = create<ToolStoreState>()((set, get) => ({
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

  toggleDrawTool(drawTool: DrawToolKind): void {
    get().setDrawTool(get().drawTool === drawTool ? 'none' : drawTool);
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
