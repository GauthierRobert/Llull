/** Document-browser tabs (rail order): tab id, label, icon, rail section. Read by the Sidebar and the palette. */

import { getCommand } from '@core/commands/registry';
import { is3D, type CadDocument } from '@core/model/types';
import type { SidebarTab } from '@ui/store';
import type { IconName } from '@ui/components/Icon';

/** `core` tabs are always on the rail; `domain` tabs only while the document uses them (or pinned / open). */
type SidebarSection = 'core' | 'domain';

export interface SidebarTabSpec {
  tab: SidebarTab;
  label: string;
  /** Caption printed under the rail icon (fits the rail width). */
  shortLabel: string;
  icon: IconName;
  section: SidebarSection;
  /** One line in the "More panels" picker: what the panel is for. */
  description: string;
}

export const SIDEBAR_TAB_SPECS: readonly SidebarTabSpec[] = [
  { tab: 'objects', label: 'Objects', shortLabel: 'Objects', icon: 'cube', section: 'core', description: 'Every object, by layer' },
  { tab: 'layers', label: 'Layers', shortLabel: 'Layers', icon: 'layers', section: 'core', description: 'Colors, visibility, locks' },
  {
    tab: 'parameters',
    label: 'Parameters',
    shortLabel: 'Params',
    icon: 'parameters',
    section: 'core',
    description: 'Named values that drive the model',
  },
  { tab: 'history', label: 'History', shortLabel: 'History', icon: 'history', section: 'core', description: 'Feature timeline, replay' },
  {
    tab: 'materials',
    label: 'Materials',
    shortLabel: 'Materials',
    icon: 'materials',
    section: 'core',
    description: 'Densities and appearance',
  },
  {
    tab: 'building',
    label: 'Building',
    shortLabel: 'Building',
    icon: 'building',
    section: 'domain',
    description: 'Levels, grids, columns, beams, walls, slabs',
  },
  {
    tab: 'civil',
    label: 'Civil / Site',
    shortLabel: 'Site',
    icon: 'terrain',
    section: 'domain',
    description: 'Terrain, alignments, roads, earthworks',
  },
  {
    tab: 'sheets',
    label: 'Drawing sheets',
    shortLabel: 'Sheets',
    icon: 'square',
    section: 'domain',
    description: 'Paper layouts and views',
  },
  { tab: 'pmi', label: 'PMI', shortLabel: 'PMI', icon: 'ruler', section: 'domain', description: 'Datums, tolerances, sizes, saved views' },
  { tab: 'assembly', label: 'Assembly', shortLabel: 'Parts', icon: 'assembly', section: 'domain', description: 'Components and instances' },
  {
    tab: 'mechanisms',
    label: 'Mechanisms',
    shortLabel: 'Motion',
    icon: 'mechanism',
    section: 'domain',
    description: 'Constraints, joints, drives, physics',
  },
  {
    tab: 'configurations',
    label: 'Configurations',
    shortLabel: 'Variants',
    icon: 'configurations',
    section: 'domain',
    description: 'Named variants of the parameters',
  },
  {
    tab: 'manufacturing',
    label: 'Manufacturing',
    shortLabel: 'Mfg',
    icon: 'manufacturing',
    section: 'domain',
    description: 'Sheet-metal parts, flat patterns, checks',
  },
  {
    tab: 'fasteners',
    label: 'Fasteners',
    shortLabel: 'Fasteners',
    icon: 'fastener',
    section: 'domain',
    description: 'Bolted joints and stacks',
  },
  {
    tab: 'analysis',
    label: 'Analysis',
    shortLabel: 'FEA',
    icon: 'wireframe',
    section: 'domain',
    description: 'Finite-element and thermal cases',
  },
  {
    tab: 'aero',
    label: 'Aerodynamics',
    shortLabel: 'Aero',
    icon: 'aero',
    section: 'domain',
    description: 'Drag, frontal area, airfoil lift and pressure',
  },
  { tab: 'review', label: 'Review', shortLabel: 'Review', icon: 'review', section: 'domain', description: 'Prototype check findings' },
];

/** How many items the panel lists (screen-reader label on the rail; >0 puts a domain tab on the rail). */
export const SIDEBAR_TAB_COUNTS: Readonly<Record<SidebarTab, (doc: CadDocument) => number>> = {
  objects: (doc) => doc.order.length,
  building: (doc) => doc.building?.elementOrder.length ?? 0,
  civil: (doc) => doc.civil?.order.length ?? 0,
  layers: (doc) => doc.layerOrder.length,
  sheets: (doc) => doc.drawings?.order.length ?? 0,
  pmi: (doc) => doc.pmi?.order.length ?? 0,
  assembly: (doc) => Object.keys(doc.components).length,
  mechanisms: (doc) => doc.constraintOrder.length + doc.jointOrder.length + doc.driveRelationOrder.length,
  parameters: (doc) => Object.keys(doc.parameters).length,
  history: (doc) => doc.featureHistory.length,
  configurations: (doc) => Object.keys(doc.configurations).length,
  materials: (doc) => Object.keys(doc.materials).length,
  manufacturing: (doc) => Object.keys(doc.sheetMetal?.parts ?? {}).length,
  fasteners: (doc) => Object.keys(doc.fasteners?.stacks ?? {}).length,
  analysis: (doc) => doc.analysis?.caseOrder.length ?? 0,
  aero: (doc) => Object.values(doc.entities).filter((entity) => is3D(entity) && entity.kind !== 'image').length,
  review: () => 0,
};

/** The Review tab appears once prototype checks can run (check_prototype registered) or a result is loaded. */
export function isSidebarTabAvailable(tab: SidebarTab, reviewLoaded: boolean): boolean {
  if (tab === 'manufacturing') return getCommand('check_sheet_metal') !== undefined;
  if (tab === 'aero') return getCommand('aero_drag') !== undefined;
  if (tab === 'fasteners') return getCommand('select_fastener') !== undefined;
  return tab !== 'review' || reviewLoaded || getCommand('check_prototype') !== undefined || getCommand('check_assembly') !== undefined;
}

interface RailContext {
  doc: CadDocument;
  activeTab: SidebarTab;
  pinnedTabs: readonly SidebarTab[];
  reviewLoaded: boolean;
}

/** On the rail: core tabs, the open tab, pinned tabs, and domain tabs the document already uses (Blender-style context tabs). */
function isOnRail(spec: SidebarTabSpec, { doc, activeTab, pinnedTabs, reviewLoaded }: RailContext): boolean {
  if (spec.section === 'core' || spec.tab === activeTab || pinnedTabs.includes(spec.tab)) return true;
  if (spec.tab === 'review') return reviewLoaded;
  return SIDEBAR_TAB_COUNTS[spec.tab](doc) > 0;
}

/** Available tabs split into the rail and the "More panels" picker, both in catalog order. */
export function partitionSidebarTabs(context: RailContext): { rail: SidebarTabSpec[]; more: SidebarTabSpec[] } {
  const available = SIDEBAR_TAB_SPECS.filter((spec) => isSidebarTabAvailable(spec.tab, context.reviewLoaded));
  return { rail: available.filter((spec) => isOnRail(spec, context)), more: available.filter((spec) => !isOnRail(spec, context)) };
}
