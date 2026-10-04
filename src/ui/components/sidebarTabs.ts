/**
 * @layer ui/components
 *
 * Document-browser tabs (rail order): tab id, label, icon. Read by the Sidebar and the palette.
 */

import type { SidebarTab } from '@ui/store';
import type { IconName } from '@ui/components/Icon';

export interface SidebarTabSpec {
  tab: SidebarTab;
  label: string;
  icon: IconName;
}

export const SIDEBAR_TAB_SPECS: readonly SidebarTabSpec[] = [
  { tab: 'building', label: 'Building', icon: 'building' },
  { tab: 'layers', label: 'Layers', icon: 'layers' },
  { tab: 'assembly', label: 'Assembly', icon: 'assembly' },
  { tab: 'mechanisms', label: 'Mechanisms', icon: 'mechanism' },
  { tab: 'parameters', label: 'Parameters', icon: 'parameters' },
  { tab: 'history', label: 'History', icon: 'history' },
  { tab: 'configurations', label: 'Configurations', icon: 'configurations' },
  { tab: 'materials', label: 'Materials', icon: 'materials' },
];
