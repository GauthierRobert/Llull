// Color theme ('dark' | 'light') as `data-theme` on <html>; persisted once chosen, else follows the OS live. UI-only.

import { create } from 'zustand';

export type Theme = 'dark' | 'light';

const STORAGE_KEY = 'llull-theme';

const LIGHT_QUERY = '(prefers-color-scheme: light)';

function readStoredTheme(): Theme | null {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'light' || stored === 'dark') return stored;
  } catch {
    // localStorage unavailable (test env or sandboxed iframe)
  }
  return null;
}

function lightMediaQuery(): MediaQueryList | null {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(LIGHT_QUERY) : null;
}

function systemTheme(): Theme {
  return lightMediaQuery()?.matches === true ? 'light' : 'dark';
}

function persistTheme(theme: Theme): void {
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // ignore
  }
}

interface ThemeStoreState {
  theme: Theme;
  toggleTheme(): void;
  setTheme(theme: Theme): void;
}

export const useThemeStore = create<ThemeStoreState>()((set) => ({
  theme: readStoredTheme() ?? systemTheme(),

  toggleTheme(): void {
    set((state) => {
      const next: Theme = state.theme === 'dark' ? 'light' : 'dark';
      persistTheme(next);
      return { theme: next };
    });
  },

  setTheme(theme: Theme): void {
    persistTheme(theme);
    set({ theme });
  },
}));

// Follow OS theme changes while the user has not chosen a theme explicitly.
const systemQuery = lightMediaQuery();
const onSystemThemeChange = (): void => {
  if (readStoredTheme() === null) useThemeStore.setState({ theme: systemTheme() });
};
systemQuery?.addEventListener?.('change', onSystemThemeChange);
// A hot-reloaded module would otherwise leave its listener behind next to the new one.
import.meta.hot?.dispose(() => systemQuery?.removeEventListener?.('change', onSystemThemeChange));
