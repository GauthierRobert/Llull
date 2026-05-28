/**
 * Public API for the Zustand CAD store.
 *
 * Import the hook and the state type from here — never import from store.ts directly.
 */

export { useStore } from './store';
export type { CadStoreState, LastMeasure } from './store';

export { useThemeStore } from './themeStore';
export type { ThemeStoreState, Theme } from './themeStore';

export { useViewportStore } from './viewportStore';
export type { ViewportStoreState, DisplayMode, ClipAxis, ClipPlaneState, QualityTier, QualityOverride } from './viewportStore';

export { useNamedViewStore } from './namedViewStore';
export type { NamedViewStoreState, NamedView, NamedViewCamera } from './namedViewStore';
