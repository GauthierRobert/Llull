/**
 * @layer ui/components
 *
 * Sidebar — vertical icon rail + the one document browser panel it selects
 * (layers, assembly, mechanisms, parameters, history, configurations, materials).
 * Tab state lives in useLayoutStore (presentation only — never document state).
 */

import React from 'react';
import { useLayoutStore, useStore } from '@ui/store';
import type { SidebarTab } from '@ui/store';
import { Icon } from '@ui/components/Icon';
import type { IconName } from '@ui/components/Icon';
import { LayersPanel } from '@ui/panels/LayersPanel';
import { AssemblyPanel } from '@ui/panels/AssemblyPanel';
import { MechanismsPanel } from '@ui/panels/MechanismsPanel';
import { ParametersPanel } from '@ui/panels/ParametersPanel';
import { FeatureHistoryPanel } from '@ui/panels/FeatureHistoryPanel';
import { ConfigurationsPanel } from '@ui/panels/ConfigurationsPanel';
import { MaterialsPanel } from '@ui/panels/MaterialsPanel';

interface SidebarTabSpec {
  tab: SidebarTab;
  label: string;
  icon: IconName;
}

const TABS: readonly SidebarTabSpec[] = [
  { tab: 'layers', label: 'Layers', icon: 'layers' },
  { tab: 'assembly', label: 'Assembly', icon: 'assembly' },
  { tab: 'mechanisms', label: 'Mechanisms', icon: 'mechanism' },
  { tab: 'parameters', label: 'Parameters', icon: 'parameters' },
  { tab: 'history', label: 'History', icon: 'history' },
  { tab: 'configurations', label: 'Configurations', icon: 'configurations' },
  { tab: 'materials', label: 'Materials', icon: 'materials' },
];

/** Item count shown as a badge on each rail button. */
function useTabCount(tab: SidebarTab): number {
  return useStore((s) => {
    const doc = s.document;
    switch (tab) {
      case 'layers':
        return doc.layerOrder.length;
      case 'assembly':
        return Object.keys(doc.components).length;
      case 'mechanisms':
        return doc.constraintOrder.length + doc.jointOrder.length + doc.driveRelationOrder.length;
      case 'parameters':
        return Object.keys(doc.parameters).length;
      case 'history':
        return doc.featureHistory.length;
      case 'configurations':
        return Object.keys(doc.configurations).length;
      case 'materials':
        return Object.keys(doc.materials).length;
    }
  });
}

interface RailButtonProps {
  spec: SidebarTabSpec;
  active: boolean;
  onSelect: (tab: SidebarTab) => void;
}

function RailButton({ spec, active, onSelect }: RailButtonProps): React.ReactElement {
  const count = useTabCount(spec.tab);
  return (
    <button
      type="button"
      role="tab"
      id={`sidebar-tab-${spec.tab}`}
      aria-selected={active}
      aria-controls={active ? 'sidebar-panel' : undefined}
      aria-label={spec.label}
      title={spec.label}
      className={`rail-btn${active ? ' rail-btn--active' : ''}`}
      onClick={() => onSelect(spec.tab)}
    >
      <Icon name={spec.icon} size={18} />
      {count > 0 && (
        <span className="rail-btn__badge" aria-hidden="true">
          {count > 99 ? '99+' : count}
        </span>
      )}
    </button>
  );
}

function ActivePanel({ tab }: { tab: SidebarTab }): React.ReactElement {
  switch (tab) {
    case 'layers':
      return <LayersPanel className="sidebar-panel" />;
    case 'assembly':
      return <AssemblyPanel className="sidebar-panel" />;
    case 'mechanisms':
      return <MechanismsPanel className="sidebar-panel" />;
    case 'parameters':
      return <ParametersPanel className="sidebar-panel" />;
    case 'history':
      return <FeatureHistoryPanel className="sidebar-panel" />;
    case 'configurations':
      return <ConfigurationsPanel className="sidebar-panel" />;
    case 'materials':
      return <MaterialsPanel className="sidebar-panel" />;
  }
}

export function Sidebar(): React.ReactElement {
  const sidebarTab = useLayoutStore((s) => s.sidebarTab);
  const sidebarOpen = useLayoutStore((s) => s.sidebarOpen);
  const selectSidebarTab = useLayoutStore((s) => s.selectSidebarTab);

  return (
    <div className={`sidebar${sidebarOpen ? '' : ' sidebar--collapsed'}`}>
      <nav
        className="rail"
        role="tablist"
        aria-orientation="vertical"
        aria-label="Document browser"
      >
        {TABS.map((spec) => (
          <RailButton
            key={spec.tab}
            spec={spec}
            active={sidebarOpen && spec.tab === sidebarTab}
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
          <ActivePanel tab={sidebarTab} />
        </div>
      )}
    </div>
  );
}
