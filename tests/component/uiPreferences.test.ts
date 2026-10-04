/**
 * Presentation defaults read at store creation: the theme follows the OS until the user picks one,
 * and on a narrow (drawer-layout) window both docks start closed without overwriting the stored
 * desktop layout. Each case re-imports the store module under a stubbed `matchMedia`.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

type ChangeListener = () => void;

function stubMatchMedia(matching: (query: string) => boolean): { fireChange: () => void } {
  const listeners: ChangeListener[] = [];
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      get matches(): boolean {
        return matching(query);
      },
      media: query,
      addEventListener: (_type: string, listener: ChangeListener) => listeners.push(listener),
      removeEventListener: vi.fn(),
    })),
  );
  return { fireChange: () => listeners.forEach((listener) => listener()) };
}

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('themeStore — system preference', () => {
  it('starts from the OS theme and follows it live while no choice is stored', async () => {
    let prefersLight = true;
    const media = stubMatchMedia((query) => query.includes('light') && prefersLight);
    const { useThemeStore } = await import('@ui/store/themeStore');
    expect(useThemeStore.getState().theme).toBe('light');

    prefersLight = false;
    media.fireChange();
    expect(useThemeStore.getState().theme).toBe('dark');
  });

  it('keeps an explicit choice over the OS theme', async () => {
    localStorage.setItem('llull-theme', 'dark');
    const media = stubMatchMedia((query) => query.includes('light'));
    const { useThemeStore } = await import('@ui/store/themeStore');
    expect(useThemeStore.getState().theme).toBe('dark');
    media.fireChange();
    expect(useThemeStore.getState().theme).toBe('dark');
  });

  it('defaults to dark when matchMedia is unavailable', async () => {
    vi.stubGlobal('matchMedia', undefined);
    const { useThemeStore } = await import('@ui/store/themeStore');
    expect(useThemeStore.getState().theme).toBe('dark');
  });
});

describe('layoutStore — narrow windows', () => {
  it('starts with both docks closed on a drawer-layout window, leaving storage untouched', async () => {
    localStorage.setItem(
      'llull-layout',
      JSON.stringify({ sidebarTab: 'history', sidebarOpen: true, inspectorOpen: true }),
    );
    stubMatchMedia((query) => query.includes('max-width'));
    const { useLayoutStore } = await import('@ui/store/layoutStore');
    const state = useLayoutStore.getState();
    expect([state.sidebarTab, state.sidebarOpen, state.inspectorOpen]).toEqual([
      'history',
      false,
      false,
    ]);
    expect(JSON.parse(localStorage.getItem('llull-layout') ?? '{}')).toMatchObject({
      sidebarOpen: true,
    });
  });

  it('keeps the stored docks on a wide window', async () => {
    stubMatchMedia(() => false);
    const { useLayoutStore } = await import('@ui/store/layoutStore');
    expect(useLayoutStore.getState().sidebarOpen).toBe(true);
    expect(useLayoutStore.getState().inspectorOpen).toBe(true);
  });
});
