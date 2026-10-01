import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useLayoutStore } from '@ui/store';

describe('layoutStore', () => {
  beforeEach(() => {
    localStorage.clear();
    useLayoutStore.setState({ sidebarTab: 'layers', sidebarOpen: true, inspectorOpen: true });
  });

  it('selecting a new tab opens it', () => {
    useLayoutStore.setState({ sidebarOpen: false });
    useLayoutStore.getState().selectSidebarTab('history');
    expect(useLayoutStore.getState().sidebarTab).toBe('history');
    expect(useLayoutStore.getState().sidebarOpen).toBe(true);
  });

  it('selecting the open tab collapses the sidebar', () => {
    useLayoutStore.getState().selectSidebarTab('layers');
    expect(useLayoutStore.getState().sidebarOpen).toBe(false);
  });

  it('toggles the inspector and persists the layout', () => {
    useLayoutStore.getState().toggleInspector();
    expect(useLayoutStore.getState().inspectorOpen).toBe(false);
    const stored: unknown = JSON.parse(localStorage.getItem('llull-layout') ?? '{}');
    expect(stored).toMatchObject({ inspectorOpen: false, sidebarTab: 'layers' });
  });

  it('toggles the sidebar', () => {
    useLayoutStore.getState().toggleSidebar();
    expect(useLayoutStore.getState().sidebarOpen).toBe(false);
  });
});

describe('layoutStore — persisted layout parsing', () => {
  it('falls back to defaults for corrupt or invalid stored layout', async () => {
    localStorage.setItem('llull-layout', JSON.stringify({ sidebarTab: 'nope', sidebarOpen: 3 }));
    vi.resetModules();
    const fresh = await import('@ui/store/layoutStore');
    expect(fresh.useLayoutStore.getState().sidebarTab).toBe('layers');
    expect(fresh.useLayoutStore.getState().sidebarOpen).toBe(true);

    localStorage.setItem('llull-layout', '{not json');
    vi.resetModules();
    const again = await import('@ui/store/layoutStore');
    expect(again.useLayoutStore.getState().inspectorOpen).toBe(true);
  });

  it('restores a valid stored layout', async () => {
    localStorage.setItem(
      'llull-layout',
      JSON.stringify({ sidebarTab: 'history', sidebarOpen: false, inspectorOpen: false }),
    );
    vi.resetModules();
    const fresh = await import('@ui/store/layoutStore');
    expect(fresh.useLayoutStore.getState()).toMatchObject({
      sidebarTab: 'history',
      sidebarOpen: false,
      inspectorOpen: false,
    });
  });
});
