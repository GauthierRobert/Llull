/** Document-browser tabs (rail order): tab id, label, icon. Read by the Sidebar and the palette. */

import { getCommand } from '@core/commands/registry';
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
  { tab: 'objects', label: 'Objects', shortLabel: 'Objects', icon: 'cube' },
  { tab: 'building', label: 'Building', shortLabel: 'Building', icon: 'building' },
  { tab: 'civil', label: 'Civil / Site', shortLabel: 'Site', icon: 'terrain' },
  { tab: 'layers', label: 'Layers', shortLabel: 'Layers', icon: 'layers' },
  { tab: 'sheets', label: 'Drawing sheets', shortLabel: 'Sheets', icon: 'square' },
  { tab: 'assembly', label: 'Assembly', shortLabel: 'Parts', icon: 'assembly' },
  { tab: 'mechanisms', label: 'Mechanisms', shortLabel: 'Motion', icon: 'mechanism' },
  { tab: 'parameters', label: 'Parameters', shortLabel: 'Params', icon: 'parameters' },
  { tab: 'history', label: 'History', shortLabel: 'History', icon: 'history' },
  { tab: 'configurations', label: 'Configurations', shortLabel: 'Variants', icon: 'configurations' },
  { tab: 'materials', label: 'Materials', shortLabel: 'Materials', icon: 'materials' },
  { tab: 'manufacturing', label: 'Manufacturing', shortLabel: 'Mfg', icon: 'manufacturing' },
  { tab: 'fasteners', label: 'Fasteners', shortLabel: 'Fasteners', icon: 'fastener' },
  { tab: 'analysis', label: 'Analysis (FEA / thermal)', shortLabel: 'Analysis', icon: 'analysis' },
  { tab: 'review', label: 'Review', shortLabel: 'Review', icon: 'review' },
];

/** The Review tab appears once prototype checks can run (check_prototype registered) or a result is loaded. */
export function isSidebarTabAvailable(tab: SidebarTab, reviewLoaded: boolean): boolean {
  if (tab === 'manufacturing') return getCommand('check_sheet_metal') !== undefined;
  if (tab === 'analysis') return getCommand('create_analysis') !== undefined;
  if (tab === 'fasteners') return getCommand('select_fastener') !== undefined;
  return tab !== 'review' || reviewLoaded || getCommand('check_prototype') !== undefined;
}
