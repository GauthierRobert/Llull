/**
 * Public API for the Zustand CAD store.
 *
 * Import the hook and the state type from here — never import from store.ts directly.
 */

export { useStore } from './store';
export type { CadStoreState, LastMeasure, DispatchOptions } from './store';

export { useThemeStore } from './themeStore';
export type { ThemeStoreState, Theme } from './themeStore';

export { useViewportStore } from './viewportStore';
export type {
  ViewportStoreState,
  DisplayMode,
  ClipAxis,
  ClipPlaneState,
  QualityTier,
  QualityOverride,
  MechanismSelection,
  MechanismSelectionKind,
} from './viewportStore';

export { useNamedViewStore } from './namedViewStore';
export type { NamedViewStoreState, NamedView, NamedViewCamera } from './namedViewStore';

export { useLayoutStore } from './layoutStore';
export type { LayoutStoreState, SidebarTab } from './layoutStore';

export { useToolStore } from './toolStore';
export type { ToolStoreState, ViewMode, DrawToolKind, GizmoMode } from './toolStore';
