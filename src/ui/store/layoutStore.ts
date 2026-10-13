// Persisted layout UI state: open sidebar tab, dock expansion. In the narrow drawer layout (shell.css) both docks start
// closed without touching the stored desktop preference until the user toggles one.

import { create } from 'zustand';
import { isRecord } from '@lib/isRecord';
import { readStored, writeStored } from './persistence';

const SIDEBAR_TABS = [
  'building',
  'civil',
  'layers',
  'assembly',
  'mechanisms',
  'parameters',
  'history',
  'configurations',
  'materials',
] as const;

export type SidebarTab = (typeof SIDEBAR_TABS)[number];

const STORAGE_KEY = 'llull-layout';

/** The shell.css drawer-layout breakpoint. */
const DRAWER_LAYOUT_QUERY = '(max-width: 1024px)';

function isDrawerLayout(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.(DRAWER_LAYOUT_QUERY).matches === true;
}

interface PersistedLayout {
  sidebarTab: SidebarTab;
  sidebarOpen: boolean;
  inspectorOpen: boolean;
}

const DEFAULT_LAYOUT: PersistedLayout = { sidebarTab: 'layers', sidebarOpen: true, inspectorOpen: true };

function isSidebarTab(value: unknown): value is SidebarTab {
  return SIDEBAR_TABS.some((tab) => tab === value);
}

const booleanOr = (value: unknown, fallback: boolean): boolean => (typeof value === 'boolean' ? value : fallback);

function readStoredLayout(): PersistedLayout {
  const stored = readStored(STORAGE_KEY);
  if (!isRecord(stored)) return DEFAULT_LAYOUT;
  return {
    sidebarTab: isSidebarTab(stored.sidebarTab) ? stored.sidebarTab : DEFAULT_LAYOUT.sidebarTab,
    sidebarOpen: booleanOr(stored.sidebarOpen, DEFAULT_LAYOUT.sidebarOpen),
    inspectorOpen: booleanOr(stored.inspectorOpen, DEFAULT_LAYOUT.inspectorOpen),
  };
}

interface LayoutStoreState extends PersistedLayout {
  /** Re-selecting the open tab collapses the sidebar. */
  selectSidebarTab(tab: SidebarTab): void;
  toggleSidebar(): void;
  toggleInspector(): void;
}

export const useLayoutStore = create<LayoutStoreState>()((set, get) => {
  // Persist only the changed fields: a dock forced closed by the drawer layout never overwrites the desktop preference.
  const commit = (patch: Partial<PersistedLayout>): void => {
    writeStored(STORAGE_KEY, { ...readStoredLayout(), ...patch });
    set(patch);
  };

  return {
    ...readStoredLayout(),
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
