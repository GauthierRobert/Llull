/**
 * Public API for the Zustand CAD store.
 *
 * Import the hook and the state type from here — never import from store.ts directly.
 */

export { useStore } from './store';
export type { CadStoreState } from './store';

export { useThemeStore } from './themeStore';
export type { ThemeStoreState, Theme } from './themeStore';
