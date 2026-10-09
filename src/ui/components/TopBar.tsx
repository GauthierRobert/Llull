/**
 * @layer ui/components
 *
 * TopBar — application header: sidebar toggle, brand, file breadcrumbs, command-palette trigger
 * (Ctrl/Cmd+K), agent pill (liveStatus), project / export / connect actions, theme and inspector
 * toggles. Presentation only (react R1).
 */

import React from 'react';
import { classNames } from '@ui/classNames';
import { useLayoutStore, usePaletteStore, useStore } from '@ui/store';
import type { LiveStatus } from '@ui/store';
import { useSessionStore } from '@ui/store/sessionStore';
import { projectNameOf } from '@ui/components/projectName';
import { Icon } from '@ui/components/Icon';
import { ThemeToggle } from '@ui/components/ThemeToggle';
import { ProjectIO } from '@ui/components/ProjectIO';
import { ModelExport } from '@ui/components/ModelExport';
import { McpConnectButton } from '@ui/components/McpConnect';
import { PALETTE_SHORTCUT_LABEL } from '@ui/hooks/shortcuts';

function AgentPill({ status }: { status: LiveStatus }): React.ReactElement {
  const isConnected = status === 'connected';
  const isConnecting = status === 'connecting';

  const label = `MCP agent: ${status}`;

  return (
    <div
      className={classNames(
        'agent-pill',
        isConnected && 'agent-pill--connected',
        isConnecting && 'agent-pill--connecting',
      )}
      aria-label={label}
      title={label}
    >
      <span className="agent-pill__dot" aria-hidden="true" />
      <span className="agent-pill__text">
        {isConnected ? 'claude-mcp' : isConnecting ? 'connecting…' : 'offline'}
      </span>
    </div>
  );
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
      title={label}
    >
      <Icon name="panelLeft" size={16} />
    </button>
  );
}

function InspectorToggle(): React.ReactElement {
  const inspectorOpen = useLayoutStore((s) => s.inspectorOpen);
  const toggleInspector = useLayoutStore((s) => s.toggleInspector);
  const label = inspectorOpen ? 'Hide properties panel' : 'Show properties panel';
  return (
    <button
      type="button"
      className={`icon-btn${inspectorOpen ? ' icon-btn--active' : ''}`}
      onClick={toggleInspector}
      aria-label={label}
      title={label}
    >
      <Icon name="panelRight" size={16} />
    </button>
  );
}

function SearchTrigger(): React.ReactElement {
  const setOpen = usePaletteStore((s) => s.setOpen);
  const shortcut = PALETTE_SHORTCUT_LABEL;
  return (
    <button
      type="button"
      className="search-trigger"
      onClick={() => setOpen(true)}
      aria-label={`Search or run a command… ${shortcut}`}
      aria-keyshortcuts="Control+K Meta+K"
      title={`Search every action and command (${shortcut})`}
    >
      <Icon name="search" size={14} />
      <span className="search-trigger__text">Search or run a command…</span>
      <kbd className="kbd search-trigger__kbd">{shortcut}</kbd>
    </button>
  );
}

export function TopBar(): React.ReactElement {
  const liveStatus = useStore((s) => s.liveStatus);
  const projectName = useStore((s) => projectNameOf(s.document));
  const isDirty = useSessionStore((s) => s.dirty);

  return (
    <header className="topbar" role="banner">
      <div className="topbar__left">
        <SidebarToggle />

        <div className="brand" aria-label="Llull CAD">
          <div className="brand-mark" aria-hidden="true">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
              <path d="M12 2.5 3.5 7v10L12 21.5 20.5 17V7L12 2.5Z" fill="currentColor" />
              <path
                d="M3.5 7 12 11.5 20.5 7M12 11.5v10"
                stroke="var(--surface-1)"
                strokeWidth="1.6"
                strokeLinejoin="round"
              />
            </svg>
          </div>
          <h1 className="brand-wordmark">Llull</h1>
        </div>

        <span className="topbar__sep" aria-hidden="true" />

        <nav className="file-crumbs" aria-label="File location">
          <span className="file-crumb file-crumb--active">{projectName ?? 'Untitled'}</span>
          {isDirty && (
            <span
              className="unsaved-dot"
              role="status"
              aria-label="Unsaved changes"
              title="Unsaved changes"
            >
              ●<span className="unsaved-dot__label"> unsaved</span>
            </span>
          )}
        </nav>
      </div>

      <SearchTrigger />

      <div className="topbar__right">
        <AgentPill status={liveStatus} />
        <span className="topbar__sep" aria-hidden="true" />
        <ProjectIO />
        <ModelExport />
        <McpConnectButton />
        <span className="topbar__sep" aria-hidden="true" />
        <ThemeToggle />
        <InspectorToggle />
      </div>
    </header>
  );
}
