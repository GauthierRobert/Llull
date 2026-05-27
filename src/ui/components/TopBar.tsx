/**
 * @layer ui/components
 *
 * TopBar — 44px application header.
 *
 * Slots (left → right):
 *   - Brand mark + wordmark
 *   - File breadcrumbs (static "Workshop / Untitled")
 *   - Tab bar: Design (active) + Render (aria-disabled, coming soon)
 *   - Agent pill: driven by liveStatus from the store
 *   - Avatar: gradient circle with initials
 *
 * No document mutation here — purely presentational (react R1).
 * Reads: useStore(s => s.liveStatus).
 */

import React from 'react';
import { useStore } from '@ui/store';

// ---------------------------------------------------------------------------
// AgentPill — amber when connected, neutral otherwise
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// TopBar
// ---------------------------------------------------------------------------

export function TopBar(): React.ReactElement {
  const liveStatus = useStore((s) => s.liveStatus);

  return (
    <header className="topbar" role="banner">
      {/* Brand */}
      <div className="brand" aria-label="Llull CAD">
        <div className="brand-mark" aria-hidden="true" />
        <span className="brand-wordmark">Llull</span>
      </div>

      {/* File breadcrumbs */}
      <nav className="file-crumbs" aria-label="File location">
        <span className="file-crumb">Workshop</span>
        <span className="file-crumb-sep" aria-hidden="true">/</span>
        <span className="file-crumb file-crumb--active">Untitled</span>
      </nav>

      {/* Tab bar */}
      <nav className="tabbar" aria-label="Workspace tabs">
        <button
          type="button"
          className="tab tab--active"
          aria-pressed={true}
          aria-current="page"
        >
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

      {/* Right cluster */}
      <div className="topbar-right">
        <AgentPill status={liveStatus} />

        {/* Avatar: static initials */}
        <div className="avatar" aria-label="User avatar" title="User">
          G
        </div>
      </div>
    </header>
  );
}
