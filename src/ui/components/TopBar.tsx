/**
 * @layer ui/components
 *
 * TopBar — 48px application header.
 *
 * Slots (left → right):
 *   - Sidebar toggle, brand mark + wordmark, file breadcrumbs
 *   - Workspace tabs: Design (active) + Render (aria-disabled, coming soon)
 *   - Agent pill (liveStatus), project Open/Save, Connect agent, theme toggle,
 *     inspector toggle, avatar
 *
 * No document mutation here — purely presentational (react R1).
 */

import React from 'react';
import { useLayoutStore, useStore } from '@ui/store';
import { Icon } from '@ui/components/Icon';
import { ThemeToggle } from '@ui/components/ThemeToggle';
import { ProjectIO } from '@ui/components/ProjectIO';
import { ModelExport } from '@ui/components/ModelExport';
import { McpConnectButton } from '@ui/components/McpConnect';

interface AgentPillProps {
  status: 'connected' | 'connecting' | 'disconnected';
}

function AgentPill({ status }: AgentPillProps): React.ReactElement {
  const isConnected = status === 'connected';
  const isConnecting = status === 'connecting';

  const label = isConnected
    ? 'MCP agent: connected'
    : isConnecting
      ? 'MCP agent: connecting'
      : 'MCP agent: disconnected';

  return (
    <div
      className={[
        'agent-pill',
        isConnected ? 'agent-pill--connected' : '',
        isConnecting ? 'agent-pill--connecting' : '',
      ]
        .filter(Boolean)
        .join(' ')}
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

export function TopBar(): React.ReactElement {
  const liveStatus = useStore((s) => s.liveStatus);

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
          <span className="brand-wordmark">Llull</span>
        </div>

        <span className="topbar__sep" aria-hidden="true" />

        <nav className="file-crumbs" aria-label="File location">
          <span className="file-crumb">Workshop</span>
          <span className="file-crumb-sep" aria-hidden="true">
            /
          </span>
          <span className="file-crumb file-crumb--active">Untitled</span>
        </nav>
      </div>

      <nav className="tabbar" aria-label="Workspace tabs">
        <button type="button" className="tab tab--active" aria-pressed={true} aria-current="page">
          Design
        </button>
        <button
          type="button"
          className="tab tab--disabled"
          aria-disabled="true"
          title="Coming soon"
          tabIndex={-1}
        >
          Render
        </button>
      </nav>

      <div className="topbar__right">
        <AgentPill status={liveStatus} />
        <span className="topbar__sep" aria-hidden="true" />
        <ProjectIO />
        <ModelExport />
        <McpConnectButton />
        <span className="topbar__sep" aria-hidden="true" />
        <ThemeToggle />
        <InspectorToggle />
        <div className="avatar" aria-label="User avatar" title="User">
          G
        </div>
      </div>
    </header>
  );
}
