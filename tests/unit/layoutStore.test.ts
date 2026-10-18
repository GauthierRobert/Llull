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
    expect(stored).toMatchObject({ inspectorOpen: false, sidebarTab: 'objects' });
  });
  it('pins a tab (opening it) and unpins it, persisting the pins', () => {
    useLayoutStore.getState().pinSidebarTab('analysis');
    useLayoutStore.getState().pinSidebarTab('analysis');
    expect(useLayoutStore.getState()).toMatchObject({ sidebarTab: 'analysis', sidebarOpen: true, pinnedTabs: ['analysis'] });
    expect(JSON.parse(localStorage.getItem('llull-layout') ?? '{}')).toMatchObject({ pinnedTabs: ['analysis'] });
    useLayoutStore.getState().unpinSidebarTab('analysis');
    expect(useLayoutStore.getState().pinnedTabs).toEqual([]);
  });
  it('keeps only known tabs from stored pins', async () => {
    localStorage.setItem('llull-layout', JSON.stringify({ pinnedTabs: ['civil', 'nope', 3] }));
    vi.resetModules();
    const fresh = await import('@ui/store/layoutStore');
    expect(fresh.useLayoutStore.getState().pinnedTabs).toEqual(['civil']);
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
    expect(fresh.useLayoutStore.getState().sidebarTab).toBe('objects');
    // Lens: the browser panel starts closed (rail only); properties float in with a selection.
    expect(fresh.useLayoutStore.getState().sidebarOpen).toBe(false);
    localStorage.setItem('llull-layout', '{not json');
    vi.resetModules();
    const again = await import('@ui/store/layoutStore');
    // Properties float in with a selection by default.
    expect(again.useLayoutStore.getState().inspectorOpen).toBe(true);
    expect(again.useLayoutStore.getState().pinnedTabs).toEqual([]);
  });
  it('restores a valid stored layout', async () => {
    localStorage.setItem('llull-layout', JSON.stringify({ sidebarTab: 'history', sidebarOpen: false, inspectorOpen: false }));
    vi.resetModules();
    const fresh = await import('@ui/store/layoutStore');
    expect(fresh.useLayoutStore.getState()).toMatchObject({ sidebarTab: 'history', sidebarOpen: false, inspectorOpen: false });
  });
});
