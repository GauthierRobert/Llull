/**
 * @layer ui/store
 *
 * Theme store — tracks the active color theme ('dark' | 'light').
 *
 * Persists the user's choice to localStorage so the preference survives
 * page reloads. Until the user picks one, the theme follows the OS
 * (`prefers-color-scheme`), live. The theme is applied as a `data-theme` attribute on
 * `<html>` — all other components rely only on CSS variables.
 *
 * This is UI-only state (presentation), intentionally NOT part of CadDocument.
 */

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
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia(LIGHT_QUERY)
    : null;
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
  /** Active color theme. */
  theme: Theme;
  /** Toggle between 'dark' and 'light'. */
  toggleTheme(): void;
  /** Explicitly set the theme. */
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
lightMediaQuery()?.addEventListener?.('change', () => {
  if (readStoredTheme() === null) useThemeStore.setState({ theme: systemTheme() });
});
