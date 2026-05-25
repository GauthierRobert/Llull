/**
 * @layer ui/store
 *
 * Theme store — tracks the active color theme ('dark' | 'light').
 *
 * Persists the user's choice to localStorage so the preference survives
 * page reloads. The theme is applied as a `data-theme` attribute on
 * `<html>` — all other components rely only on CSS variables.
 *
 * This is UI-only state (presentation), intentionally NOT part of CadDocument.
 */

import { create } from 'zustand';

export type Theme = 'dark' | 'light';

const STORAGE_KEY = 'llull-theme';

function readStoredTheme(): Theme {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'light' || stored === 'dark') return stored;
  } catch {
    // localStorage unavailable (test env or sandboxed iframe)
  }
  return 'dark';
}

function persistTheme(theme: Theme): void {
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // ignore
  }
}

export interface ThemeStoreState {
  /** Active color theme. */
  theme: Theme;
  /** Toggle between 'dark' and 'light'. */
  toggleTheme(): void;
  /** Explicitly set the theme. */
  setTheme(theme: Theme): void;
}

export const useThemeStore = create<ThemeStoreState>()((set) => ({
  theme: readStoredTheme(),

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
