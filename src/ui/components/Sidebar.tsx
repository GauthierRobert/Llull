// Icon rail + the one browser panel it selects; tab state in useLayoutStore. Context-sensitive like Blender's Properties
// tabs: core panels are always on the rail, domain panels (building, FEA, fasteners…) only once the document uses them,
// is open, or the user pinned them — the rest wait behind "More panels".

import React, { useCallback, useRef, useState } from 'react';
import { type SidebarTab, useLayoutStore, useStore } from '@ui/store';
import { classNames } from '@ui/classNames';
import { useDismiss } from '@ui/hooks/useDismiss';
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
import { ManufacturingPanel } from '@ui/panels/manufacturing/ManufacturingPanel';
import { FastenersPanel } from '@ui/panels/fasteners/FastenersPanel';
import { AnalysisPanel } from '@ui/panels/analysis/AnalysisPanel';
import { AeroPanel } from '@ui/panels/aero/AeroPanel';
import { ReviewPanel } from '@ui/panels/review/ReviewPanel';
import { useReviewStore } from '@ui/panels/review/reviewStore';
import { type SidebarTabSpec, SIDEBAR_TAB_COUNTS, SIDEBAR_TAB_SPECS, isSidebarTabAvailable, partitionSidebarTabs } from './sidebarTabs';

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
  manufacturing: ManufacturingPanel,
  fasteners: FastenersPanel,
  analysis: AnalysisPanel,
  aero: AeroPanel,
  review: ReviewPanel,
};

interface RailButtonProps {
  spec: SidebarTabSpec;
  active: boolean;
  /** Roving tabindex: one rail button in the Tab order. */
  focusable: boolean;
  onSelect: (tab: SidebarTab) => void;
}

function RailButton({ spec, active, focusable, onSelect }: RailButtonProps): React.ReactElement {
  const count = useStore((s) => SIDEBAR_TAB_COUNTS[spec.tab](s.document));
  return (
    <button
      type="button"
      role="tab"
      id={`sidebar-tab-${spec.tab}`}
      aria-selected={active}
      tabIndex={focusable ? 0 : -1}
      aria-controls={active ? 'sidebar-panel' : undefined}
      aria-label={count > 0 ? `${spec.label}, ${count > 99 ? '99+' : count}` : spec.label}
      title={`${spec.label} — ${spec.description}`}
      className={`rail-btn${active ? ' rail-btn--active' : ''}`}
      onClick={() => onSelect(spec.tab)}
    >
      <Icon name={spec.icon} size={18} />
      <span className="rail-btn__caption" aria-hidden="true">
        {spec.shortLabel}
      </span>
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

/** Rail and "More panels" tab ids, as a stable string key so document edits that do not change them never re-render. */
function useRailPartition(reviewLoaded: boolean): { rail: SidebarTabSpec[]; more: SidebarTabSpec[] } {
  const activeTab = useLayoutStore((s) => s.sidebarTab);
  const pinnedTabs = useLayoutStore((s) => s.pinnedTabs);
  const key = useStore((s) => {
    const { rail, more } = partitionSidebarTabs({ doc: s.document, activeTab, pinnedTabs, reviewLoaded });
    return `${rail.map((spec) => spec.tab).join(',')}|${more.map((spec) => spec.tab).join(',')}`;
  });
  const [railKey = '', moreKey = ''] = key.split('|');
  const byKey = (list: string): SidebarTabSpec[] => SIDEBAR_TAB_SPECS.filter((spec) => list.split(',').includes(spec.tab));
  return { rail: byKey(railKey), more: byKey(moreKey) };
}

interface MorePanelsProps {
  hidden: readonly SidebarTabSpec[];
  pinned: readonly SidebarTabSpec[];
}

/** Picker for the domain panels the rail is not showing; choosing one opens it and pins it to the rail. */
function MorePanels({ hidden, pinned }: MorePanelsProps): React.ReactElement | null {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(rootRef, open, close);
  const pinSidebarTab = useLayoutStore((s) => s.pinSidebarTab);
  const unpinSidebarTab = useLayoutStore((s) => s.unpinSidebarTab);
  if (hidden.length === 0 && pinned.length === 0) return null;
  return (
    <div className="rail-more" ref={rootRef}>
      <button
        type="button"
        className={classNames('rail-btn', open && 'rail-btn--active')}
        aria-expanded={open}
        aria-controls={open ? 'rail-more-panel' : undefined}
        aria-label="More panels"
        title="More panels — building, site, motion, analysis…"
        onClick={() => setOpen((value) => !value)}
      >
        <Icon name="plus" size={18} />
        <span className="rail-btn__caption" aria-hidden="true">
          More
        </span>
      </button>
      {open && (
        <div className="rail-more__panel" id="rail-more-panel" role="group" aria-label="More panels">
          {hidden.length > 0 && <span className="rail-more__title">Add a panel</span>}
          {hidden.map((spec) => (
            <button
              key={spec.tab}
              type="button"
              className="rail-more__item"
              onClick={() => {
                pinSidebarTab(spec.tab);
                close();
              }}
            >
              <Icon name={spec.icon} size={16} />
              <span className="rail-more__text">
                <span className="rail-more__label">{spec.label}</span>
                <span className="rail-more__hint">{spec.description}</span>
              </span>
            </button>
          ))}
          {pinned.length > 0 && <span className="rail-more__title">Pinned to the rail</span>}
          {pinned.map((spec) => (
            <div key={spec.tab} className="rail-more__item rail-more__item--pinned">
              <Icon name={spec.icon} size={16} />
              <span className="rail-more__text">
                <span className="rail-more__label">{spec.label}</span>
              </span>
              <button
                type="button"
                className="icon-btn"
                aria-label={`Unpin ${spec.label}`}
                title="Unpin — the panel stays on the rail only while the model uses it"
                onClick={() => unpinSidebarTab(spec.tab)}
              >
                <Icon name="close" size={13} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function Sidebar(): React.ReactElement {
  const sidebarTab = useLayoutStore((s) => s.sidebarTab);
  const sidebarOpen = useLayoutStore((s) => s.sidebarOpen);
  const pinnedTabs = useLayoutStore((s) => s.pinnedTabs);
  const selectSidebarTab = useLayoutStore((s) => s.selectSidebarTab);
  const reviewLoaded = useReviewStore((s) => s.result !== null);
  const ActivePanel = TAB_PANELS[isSidebarTabAvailable(sidebarTab, reviewLoaded) ? sidebarTab : 'objects'];
  const { rail, more } = useRailPartition(reviewLoaded);
  const pinned = rail.filter((spec) => spec.section === 'domain' && pinnedTabs.includes(spec.tab));

  return (
    <aside aria-label="Sidebar" className={`sidebar${sidebarOpen ? '' : ' sidebar--collapsed'}`}>
      <div className="rail">
        <nav className="rail__tabs" role="tablist" aria-orientation="vertical" aria-label="Document browser" onKeyDown={handleRailKeyDown}>
          {rail.map((spec, index) => (
            <React.Fragment key={spec.tab}>
              {spec.section !== rail[index - 1]?.section && index > 0 && <span className="rail__divider" role="presentation" />}
              <RailButton
                spec={spec}
                active={sidebarOpen && spec.tab === sidebarTab}
                focusable={spec.tab === sidebarTab}
                onSelect={selectSidebarTab}
              />
            </React.Fragment>
          ))}
        </nav>
        <MorePanels hidden={more} pinned={pinned} />
      </div>
      {sidebarOpen && (
        <div className="sidebar__body" role="tabpanel" id="sidebar-panel" aria-labelledby={`sidebar-tab-${sidebarTab}`}>
          <ActivePanel className="sidebar-panel" />
        </div>
      )}
    </aside>
  );
}
