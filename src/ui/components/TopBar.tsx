// Header: browser-panel toggle, brand, breadcrumbs (project › selection); live-sync status and the More menu
// (file, export, theme, properties). The command palette trigger lives in the command bar.

import React from 'react';
import { classNames } from '@ui/classNames';
import { type LiveStatus, useLayoutStore, useStore } from '@ui/store';
import { useSessionStore } from '@ui/store/sessionStore';
import { projectNameOf } from '@ui/components/projectName';
import { Icon } from '@ui/components/Icon';
import { MoreMenu } from '@ui/components/MoreMenu';

function AgentPill({ status }: { status: LiveStatus }): React.ReactElement {
  const isConnected = status === 'connected';
  const isConnecting = status === 'connecting';

  const label = `Live sync: ${status}`;

  return (
    <div
      className={classNames('agent-pill', isConnected && 'agent-pill--connected', isConnecting && 'agent-pill--connecting')}
      aria-label={label}
      title={label}
    >
      <span className="agent-pill__dot" aria-hidden="true" />
      <span className="agent-pill__text">{isConnected ? 'live' : isConnecting ? 'connecting…' : 'offline'}</span>
    </div>
  );
}

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

export function TopBar(): React.ReactElement {
  const liveStatus = useStore((s) => s.liveStatus);
  const projectName = useStore((s) => projectNameOf(s.document));
  const isDirty = useSessionStore((s) => s.dirty);
  const selectionName = useSelectionCrumb();

  return (
    <header className="topbar" role="banner">
      <div className="topbar__left">
        <SidebarToggle />

        <div className="brand" aria-label="Llull CAD">
          <div className="brand-mark" aria-hidden="true">
            <svg width="22" height="22" viewBox="0 0 22 22" fill="none">
              <circle cx="11" cy="11" r="9.5" stroke="currentColor" strokeWidth="1.6" />
              <circle cx="11" cy="11" r="4.5" fill="var(--accent)" />
            </svg>
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
        <AgentPill status={liveStatus} />
        <MoreMenu />
      </div>
    </header>
  );
}
