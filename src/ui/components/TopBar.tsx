// Header: browser-panel toggle, brand, breadcrumbs (project › selection) on the left; on the right the 3D / 2D view switch, Help
// (shortcuts) and the More menu (file, export, theme, properties). Live-sync status sits in the status bar.

import React from 'react';
import { classNames } from '@ui/classNames';
import { type ViewMode, useLayoutStore, useStore, useToolStore } from '@ui/store';
import { useSessionStore } from '@ui/store/sessionStore';
import { projectNameOf } from '@ui/components/projectName';
import { Icon } from '@ui/components/Icon';
import { MoreMenu } from '@ui/components/MoreMenu';

/** Breadcrumb tail: the sole selected entity's name (or id), "<n> selected" for several, null for none. */
function useSelectionCrumb(): string | null {
  return useStore((s) => {
    const ids = s.document.selection.filter((id) => id in s.document.entities);
    if (ids.length === 0) return null;
    if (ids.length > 1) return `${ids.length} selected`;
    const [id] = ids;
    const entity = id === undefined ? undefined : s.document.entities[id];
    return entity === undefined ? null : (entity.name ?? entity.id);
  });
}

function SidebarToggle(): React.ReactElement {
  const sidebarOpen = useLayoutStore((s) => s.sidebarOpen);
  const toggleSidebar = useLayoutStore((s) => s.toggleSidebar);
  const label = sidebarOpen ? 'Hide browser panel' : 'Show browser panel';
  return (
    <button
      type="button"
      className={`icon-btn${sidebarOpen ? ' icon-btn--active' : ''}`}
      onClick={toggleSidebar}
      aria-label={label}
      title={`${label} — layers, parameters, history, materials…`}
    >
      <Icon name="panelLeft" size={16} />
    </button>
  );
}

const VIEW_MODES: ReadonlyArray<{ mode: ViewMode; label: string; title: string }> = [
  { mode: '3d', label: '3D', title: '3D view (3) — model and orbit in perspective' },
  { mode: '2d', label: '2D', title: '2D view (2) — sketch and draft from the top' },
];

/** The same model seen two ways (L7); always visible so the way back from a sketch is never hidden. */
function ViewModeSwitch(): React.ReactElement {
  const viewMode = useToolStore((s) => s.viewMode);
  const setViewMode = useToolStore((s) => s.setViewMode);
  return (
    <div className="view-switch" role="group" aria-label="View mode">
      {VIEW_MODES.map(({ mode, label, title }) => (
        <button
          key={mode}
          type="button"
          className="view-switch__btn"
          aria-pressed={viewMode === mode}
          title={title}
          onClick={() => setViewMode(mode)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function HelpButton(): React.ReactElement {
  const setShortcutsOpen = useToolStore((s) => s.setShortcutsOpen);
  return (
    <button
      type="button"
      className="icon-btn"
      aria-label="Shortcuts"
      title="Mouse and keyboard shortcuts (?)"
      onClick={() => setShortcutsOpen(true)}
    >
      <Icon name="help" size={16} />
    </button>
  );
}

export function TopBar(): React.ReactElement {
  const projectName = useStore((s) => projectNameOf(s.document));
  const isDirty = useSessionStore((s) => s.dirty);
  const selectionName = useSelectionCrumb();

  return (
    <header className="topbar" role="banner">
      <div className="topbar__left">
        <SidebarToggle />

        <div className="brand" aria-label="Llull CAD">
          <div className="brand-mark" aria-hidden="true">
            <img src="/favicon.svg" width={26} height={26} alt="" />
          </div>
          <h1 className="brand-wordmark">Llull</h1>
        </div>

        <span className="topbar__sep" aria-hidden="true" />

        <nav className="file-crumbs" aria-label="File location">
          <span className={classNames('file-crumb', selectionName === null && 'file-crumb--active')}>{projectName ?? 'Untitled'}</span>
          {selectionName !== null && (
            <>
              <span className="file-crumb-sep" aria-hidden="true">
                ›
              </span>
              <span className="file-crumb file-crumb--active" title={selectionName}>
                {selectionName}
              </span>
            </>
          )}
          {isDirty && (
            <span className="unsaved-dot" role="status" aria-label="Unsaved changes" title="Unsaved changes">
              ●<span className="unsaved-dot__label"> unsaved</span>
            </span>
          )}
        </nav>
      </div>

      <div className="topbar__right">
        <ViewModeSwitch />
        <span className="topbar__sep" aria-hidden="true" />
        <HelpButton />
        <MoreMenu />
      </div>
    </header>
  );
}
