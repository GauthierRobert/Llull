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
  /** Caption printed under the rail icon (fits the rail width). */
  shortLabel: string;
  icon: IconName;
}

export const SIDEBAR_TAB_SPECS: readonly SidebarTabSpec[] = [
  { tab: 'building', label: 'Building', shortLabel: 'Building', icon: 'building' },
  { tab: 'layers', label: 'Layers', shortLabel: 'Layers', icon: 'layers' },
  { tab: 'assembly', label: 'Assembly', shortLabel: 'Parts', icon: 'assembly' },
  { tab: 'mechanisms', label: 'Mechanisms', shortLabel: 'Motion', icon: 'mechanism' },
  { tab: 'parameters', label: 'Parameters', shortLabel: 'Params', icon: 'parameters' },
  { tab: 'history', label: 'History', shortLabel: 'History', icon: 'history' },
  {
    tab: 'configurations',
    label: 'Configurations',
    shortLabel: 'Variants',
    icon: 'configurations',
  },
  { tab: 'materials', label: 'Materials', shortLabel: 'Materials', icon: 'materials' },
];
