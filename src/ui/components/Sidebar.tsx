// Icon rail + the one browser panel it selects (objects, building, civil, layers, assembly, mechanisms, parameters, history,
// configurations, materials); tab state in useLayoutStore.

import React from 'react';
import type { CadDocument } from '@core/model/types';
import { type SidebarTab, useLayoutStore, useStore } from '@ui/store';
import { Icon } from '@ui/components/Icon';
import { ObjectsPanel } from '@ui/panels/ObjectsPanel';
import { LayersPanel } from '@ui/panels/LayersPanel';
import { AssemblyPanel } from '@ui/panels/AssemblyPanel';
import { MechanismsPanel } from '@ui/panels/MechanismsPanel';
import { ParametersPanel } from '@ui/panels/ParametersPanel';
import { FeatureHistoryPanel } from '@ui/panels/FeatureHistoryPanel';
import { ConfigurationsPanel } from '@ui/panels/ConfigurationsPanel';
import { MaterialsPanel } from '@ui/panels/MaterialsPanel';
import { SheetsPanel } from '@ui/panels/SheetsPanel';
import { BuildingPanel } from '@ui/panels/building/BuildingPanel';
import { CivilPanel } from '@ui/panels/civil/CivilPanel';
import { ReviewPanel } from '@ui/panels/review/ReviewPanel';
import { useReviewStore } from '@ui/panels/review/reviewStore';
import { type SidebarTabSpec, SIDEBAR_TAB_SPECS, isSidebarTabAvailable } from './sidebarTabs';

const TAB_PANELS: Readonly<Record<SidebarTab, React.ComponentType<{ className?: string }>>> = {
  objects: ObjectsPanel,
  building: BuildingPanel,
  civil: CivilPanel,
  layers: LayersPanel,
  sheets: SheetsPanel,
  assembly: AssemblyPanel,
  mechanisms: MechanismsPanel,
  parameters: ParametersPanel,
  history: FeatureHistoryPanel,
  configurations: ConfigurationsPanel,
  materials: MaterialsPanel,
  review: ReviewPanel,
};

/** Rail badge counts. */
const TAB_COUNTS: Readonly<Record<SidebarTab, (doc: CadDocument) => number>> = {
  objects: (doc) => doc.order.length,
  building: (doc) => doc.building?.elementOrder.length ?? 0,
  civil: (doc) => doc.civil?.order.length ?? 0,
  layers: (doc) => doc.layerOrder.length,
  sheets: (doc) => doc.drawings?.order.length ?? 0,
  assembly: (doc) => Object.keys(doc.components).length,
  mechanisms: (doc) => doc.constraintOrder.length + doc.jointOrder.length + doc.driveRelationOrder.length,
  parameters: (doc) => Object.keys(doc.parameters).length,
  history: (doc) => doc.featureHistory.length,
  configurations: (doc) => Object.keys(doc.configurations).length,
  materials: (doc) => Object.keys(doc.materials).length,
  review: () => 0,
};

interface RailButtonProps {
  spec: SidebarTabSpec;
  active: boolean;
  /** Roving tabindex: one rail button in the Tab order. */
  focusable: boolean;
  onSelect: (tab: SidebarTab) => void;
}

function RailButton({ spec, active, focusable, onSelect }: RailButtonProps): React.ReactElement {
  const count = useStore((s) => TAB_COUNTS[spec.tab](s.document));
  return (
    <button
      type="button"
      role="tab"
      id={`sidebar-tab-${spec.tab}`}
      aria-selected={active}
      tabIndex={focusable ? 0 : -1}
      aria-controls={active ? 'sidebar-panel' : undefined}
      aria-label={count > 0 ? `${spec.label}, ${count > 99 ? '99+' : count}` : spec.label}
      title={spec.label}
      className={`rail-btn${active ? ' rail-btn--active' : ''}`}
      onClick={() => onSelect(spec.tab)}
    >
      <Icon name={spec.icon} size={18} />
      <span className="rail-btn__caption" aria-hidden="true">
        {spec.shortLabel}
      </span>
      {count > 0 && (
        <span className="rail-btn__badge" aria-hidden="true">
          {count > 99 ? '99+' : count}
        </span>
      )}
    </button>
  );
}

/** ARIA tabs: Up/Down move focus, Home/End jump. */
function handleRailKeyDown(e: React.KeyboardEvent<HTMLElement>): void {
  const tabs = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
  const current = tabs.indexOf(document.activeElement as HTMLButtonElement);
  if (current === -1) return;
  const last = tabs.length - 1;
  const targets: Readonly<Record<string, number>> = {
    ArrowDown: current === last ? 0 : current + 1,
    ArrowUp: current === 0 ? last : current - 1,
    Home: 0,
    End: last,
  };
  const next = targets[e.key];
  if (next === undefined) return;
  e.preventDefault();
  tabs[next]?.focus();
}

export function Sidebar(): React.ReactElement {
  const sidebarTab = useLayoutStore((s) => s.sidebarTab);
  const sidebarOpen = useLayoutStore((s) => s.sidebarOpen);
  const selectSidebarTab = useLayoutStore((s) => s.selectSidebarTab);
  const reviewLoaded = useReviewStore((s) => s.result !== null);
  const ActivePanel = TAB_PANELS[isSidebarTabAvailable(sidebarTab, reviewLoaded) ? sidebarTab : 'objects'];

  return (
    <aside aria-label="Sidebar" className={`sidebar${sidebarOpen ? '' : ' sidebar--collapsed'}`}>
      <nav className="rail" role="tablist" aria-orientation="vertical" aria-label="Document browser" onKeyDown={handleRailKeyDown}>
        {SIDEBAR_TAB_SPECS.filter((spec) => isSidebarTabAvailable(spec.tab, reviewLoaded)).map((spec) => (
          <RailButton
            key={spec.tab}
            spec={spec}
            active={sidebarOpen && spec.tab === sidebarTab}
            focusable={spec.tab === sidebarTab}
            onSelect={selectSidebarTab}
          />
        ))}
      </nav>
      {sidebarOpen && (
        <div className="sidebar__body" role="tabpanel" id="sidebar-panel" aria-labelledby={`sidebar-tab-${sidebarTab}`}>
          <ActivePanel className="sidebar-panel" />
        </div>
      )}
    </aside>
  );
}
