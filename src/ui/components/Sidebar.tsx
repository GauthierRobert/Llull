/**
 * @layer ui/components
 *
 * Sidebar — vertical icon rail + the one document browser panel it selects
 * (building, civil, layers, assembly, mechanisms, parameters, history, configurations, materials).
 * Tab state lives in useLayoutStore (presentation only — never document state).
 */

import React from 'react';
import type { CadDocument } from '@core/model/types';
import { useLayoutStore, useStore } from '@ui/store';
import type { SidebarTab } from '@ui/store';
import { Icon } from '@ui/components/Icon';
import { LayersPanel } from '@ui/panels/LayersPanel';
import { AssemblyPanel } from '@ui/panels/AssemblyPanel';
import { MechanismsPanel } from '@ui/panels/MechanismsPanel';
import { ParametersPanel } from '@ui/panels/ParametersPanel';
import { FeatureHistoryPanel } from '@ui/panels/FeatureHistoryPanel';
import { ConfigurationsPanel } from '@ui/panels/ConfigurationsPanel';
import { MaterialsPanel } from '@ui/panels/MaterialsPanel';
import { BuildingPanel } from '@ui/panels/building/BuildingPanel';
import { CivilPanel } from '@ui/panels/civil/CivilPanel';
import { SIDEBAR_TAB_SPECS } from './sidebarTabs';
import type { SidebarTabSpec } from './sidebarTabs';

const TAB_PANELS: Readonly<Record<SidebarTab, React.ComponentType<{ className?: string }>>> = {
  building: BuildingPanel,
  civil: CivilPanel,
  layers: LayersPanel,
  assembly: AssemblyPanel,
  mechanisms: MechanismsPanel,
  parameters: ParametersPanel,
  history: FeatureHistoryPanel,
  configurations: ConfigurationsPanel,
  materials: MaterialsPanel,
};

/** Item count shown as a badge on each rail button. */
const TAB_COUNTS: Readonly<Record<SidebarTab, (doc: CadDocument) => number>> = {
  building: (doc) => doc.building?.elementOrder.length ?? 0,
  civil: (doc) => doc.civil?.order.length ?? 0,
  layers: (doc) => doc.layerOrder.length,
  assembly: (doc) => Object.keys(doc.components).length,
  mechanisms: (doc) =>
    doc.constraintOrder.length + doc.jointOrder.length + doc.driveRelationOrder.length,
  parameters: (doc) => Object.keys(doc.parameters).length,
  history: (doc) => doc.featureHistory.length,
  configurations: (doc) => Object.keys(doc.configurations).length,
  materials: (doc) => Object.keys(doc.materials).length,
};

interface RailButtonProps {
  spec: SidebarTabSpec;
  active: boolean;
  /** Roving tabindex: exactly one rail button is in the Tab order. */
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

/** ARIA tabs pattern: Arrow Up/Down move focus between rail tabs, Home/End jump to the ends. */
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
  const ActivePanel = TAB_PANELS[sidebarTab];

  return (
    <aside aria-label="Sidebar" className={`sidebar${sidebarOpen ? '' : ' sidebar--collapsed'}`}>
      <nav
        className="rail"
        role="tablist"
        aria-orientation="vertical"
        aria-label="Document browser"
        onKeyDown={handleRailKeyDown}
      >
        {SIDEBAR_TAB_SPECS.map((spec) => (
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
        <div
          className="sidebar__body"
          role="tabpanel"
          id="sidebar-panel"
          aria-labelledby={`sidebar-tab-${sidebarTab}`}
        >
          <ActivePanel className="sidebar-panel" />
        </div>
      )}
    </aside>
  );
}
