/**
 * @layer ui/store
 *
 * Layout store — which sidebar tab is open and whether the docks are expanded.
 * Presentation-only UI state, persisted to localStorage; never part of CadDocument.
 * On a narrow window (drawer layout, see shell.css) both docks start closed so the viewport is
 * visible; the stored desktop preference is left untouched until the user toggles a dock.
 */

import { create } from 'zustand';

export type SidebarTab =
  | 'building'
  | 'layers'
  | 'assembly'
  | 'mechanisms'
  | 'parameters'
  | 'history'
  | 'configurations'
  | 'materials';

const SIDEBAR_TABS: readonly SidebarTab[] = [
  'building',
  'layers',
  'assembly',
  'mechanisms',
  'parameters',
  'history',
  'configurations',
  'materials',
];

const STORAGE_KEY = 'llull-layout';

/** Matches the shell.css breakpoint below which the docks float over the viewport as drawers. */
export const DRAWER_LAYOUT_QUERY = '(max-width: 1024px)';

function isDrawerLayout(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.(DRAWER_LAYOUT_QUERY).matches === true;
}

interface PersistedLayout {
  sidebarTab: SidebarTab;
  sidebarOpen: boolean;
  inspectorOpen: boolean;
}

const DEFAULT_LAYOUT: PersistedLayout = {
  sidebarTab: 'layers',
  sidebarOpen: true,
  inspectorOpen: true,
};

function isSidebarTab(value: unknown): value is SidebarTab {
  return typeof value === 'string' && (SIDEBAR_TABS as readonly string[]).includes(value);
}

function readStoredLayout(): PersistedLayout {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_LAYOUT;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return DEFAULT_LAYOUT;
    const record = parsed as Record<string, unknown>;
    return {
      sidebarTab: isSidebarTab(record.sidebarTab) ? record.sidebarTab : DEFAULT_LAYOUT.sidebarTab,
      sidebarOpen:
        typeof record.sidebarOpen === 'boolean' ? record.sidebarOpen : DEFAULT_LAYOUT.sidebarOpen,
      inspectorOpen:
        typeof record.inspectorOpen === 'boolean'
          ? record.inspectorOpen
          : DEFAULT_LAYOUT.inspectorOpen,
    };
  } catch {
    return DEFAULT_LAYOUT;
  }
}

function persistLayout(layout: PersistedLayout): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(layout));
  } catch {
    // localStorage unavailable (test env or sandboxed iframe)
  }
}

interface LayoutStoreState extends PersistedLayout {
  /** Open `tab`; selecting the already-open tab collapses the sidebar. */
  selectSidebarTab(tab: SidebarTab): void;
  toggleSidebar(): void;
  toggleInspector(): void;
}

export const useLayoutStore = create<LayoutStoreState>()((set, get) => {
  const commit = (patch: Partial<PersistedLayout>): void => {
    const { sidebarTab, sidebarOpen, inspectorOpen } = { ...get(), ...patch };
    persistLayout({ sidebarTab, sidebarOpen, inspectorOpen });
    set(patch);
  };

  const stored = readStoredLayout();
  return {
    ...stored,
    ...(isDrawerLayout() ? { sidebarOpen: false, inspectorOpen: false } : {}),

    selectSidebarTab(tab: SidebarTab): void {
      const { sidebarTab, sidebarOpen } = get();
      if (tab === sidebarTab && sidebarOpen) commit({ sidebarOpen: false });
      else commit({ sidebarTab: tab, sidebarOpen: true });
    },

    toggleSidebar(): void {
      commit({ sidebarOpen: !get().sidebarOpen });
    },

    toggleInspector(): void {
      commit({ inspectorOpen: !get().inspectorOpen });
    },
  };
});
