import { describe, it, expect, beforeEach } from 'vitest';
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
