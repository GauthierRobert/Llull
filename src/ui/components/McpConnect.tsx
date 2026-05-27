/**
 * @layer ui/components
 *
 * McpConnect — modal dialog that shows how to connect an MCP agent to llull.
 *
 * Exports:
 *   McpConnectButton  — trigger button (mounts in StatusBar)
 *   McpConnect        — modal itself (opened by McpConnectButton)
 *
 * Presentation ONLY. No document mutations (PRIME DIRECTIVE).
 * Focus management: focus trap on open, focus restore on close.
 */

import React, { useCallback, useEffect, useId, useRef, useState } from 'react';

// ---------------------------------------------------------------------------
// Static constants (no registry import — pure UI)
// ---------------------------------------------------------------------------

const SERVER_INSTALL_CMD = 'npm --prefix server install && npm --prefix server run dev';
const SERVER_START_CMD = 'npm --prefix server run dev';
const ENDPOINT_URL = 'http://localhost:3001/mcp';

interface CapabilityBadge {
  readonly label: string;
}

const CAPABILITY_BADGES: readonly CapabilityBadge[] = [
  { label: '60 tools' },
  { label: 'structuredContent (KI2)' },
  { label: 'prompts (EN2)' },
  { label: 'session isolation (KI1)' },
];

interface AgentLoopStep {
  readonly index: number;
  readonly tool: string;
  readonly description: string;
}

const AGENT_LOOP_STEPS: readonly AgentLoopStep[] = [
  {
    index: 1,
    tool: 'read cad://conventions',
    description: 'Load the llull conventions resource to understand coordinate axes, units, and entity kinds.',
  },
  {
    index: 2,
    tool: 'describe_scene',
    description: 'Inspect the current document: all entities, layers, and their properties.',
  },
  {
    index: 3,
    tool: 'add_box (or any create/edit command)',
    description: 'Create or modify geometry via any registered command (add_box, draw_line, extrude_profile, …).',
  },
  {
    index: 4,
    tool: 'render_view',
    description: 'Render a screenshot with axes, grid, units, and showLabels:true to verify the result visually.',
  },
  {
    index: 5,
    tool: 'check_model',
    description: 'Validate the model (watertight, no self-intersections) after modifications.',
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Return every focusable element inside a container, in DOM order. */
function getFocusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(
      'a[href],button:not([disabled]),input:not([disabled]),textarea:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])',
    ),
  ).filter((el) => !el.hasAttribute('hidden'));
}

// ---------------------------------------------------------------------------
// CopyButton
// ---------------------------------------------------------------------------

interface CopyButtonProps {
  readonly text: string;
  readonly label: string;
}

function CopyButton({ text, label }: CopyButtonProps): React.ReactElement {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    });
  }, [text]);

  return (
    <button
      type="button"
      className={`mcp-connect__copy-btn${copied ? ' mcp-connect__copy-btn--copied' : ''}`}
      onClick={handleCopy}
      aria-label={copied ? `${label} copied` : `Copy ${label}`}
      title={copied ? 'Copied!' : `Copy ${label}`}
    >
      {copied ? 'Copied!' : 'Copy'}
    </button>
  );
}

// ---------------------------------------------------------------------------
// McpAgentLoop — the recommended reliable-modeling loop as ordered steps
// ---------------------------------------------------------------------------

function McpAgentLoop(): React.ReactElement {
  return (
    <section className="mcp-connect__section" aria-label="Recommended agent loop">
      <p className="mcp-connect__section-label">3. Recommended agent loop</p>
      <ol className="mcp-connect__loop-list">
        {AGENT_LOOP_STEPS.map((step) => (
          <li key={step.index} className="mcp-connect__loop-item">
            <div className="mcp-connect__loop-tool-row">
              <code className="mcp-connect__loop-tool">{step.tool}</code>
              <CopyButton text={step.tool} label={`${step.tool} tool name`} />
            </div>
            <p className="mcp-connect__loop-desc">{step.description}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}

// ---------------------------------------------------------------------------
// McpConnect modal
// ---------------------------------------------------------------------------

export interface McpConnectProps {
  /** Called when the dialog requests close (Esc, backdrop click, close button). */
  readonly onClose: () => void;
}

export function McpConnect({ onClose }: McpConnectProps): React.ReactElement {
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  // Focus the first focusable element when the modal opens.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const focusable = getFocusableElements(dialog);
    focusable[0]?.focus();
  }, []);

  // Trap focus within the modal and handle Esc.
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;

      const dialog = dialogRef.current;
      if (!dialog) return;
      const focusable = getFocusableElements(dialog);
      if (focusable.length === 0) return;

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement as HTMLElement | null;

      if (e.shiftKey) {
        // Shift+Tab: if we are on the first element, wrap to last.
        if (active === first) {
          e.preventDefault();
          last?.focus();
        }
      } else {
        // Tab: if we are on the last element, wrap to first.
        if (active === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    },
    [onClose],
  );

  // Backdrop click: close when clicking outside the dialog panel.
  const handleBackdropClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (e.target === e.currentTarget) {
        onClose();
      }
    },
    [onClose],
  );

  return (
    <div
      className="mcp-connect-backdrop"
      onClick={handleBackdropClick}
      aria-hidden="false"
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="mcp-connect"
        onKeyDown={handleKeyDown}
      >
        {/* Header */}
        <div className="mcp-connect__header">
          <h2 id={titleId} className="mcp-connect__title">
            Connect an MCP agent
          </h2>
          <button
            type="button"
            className="mcp-connect__close"
            onClick={onClose}
            aria-label="Close dialog"
            title="Close"
          >
            &times;
          </button>
        </div>

        {/* Body */}
        <div className="mcp-connect__body">
          {/* Capability badges */}
          <div className="mcp-connect__badges" aria-label="Capabilities">
            {CAPABILITY_BADGES.map((badge) => (
              <span key={badge.label} className="mcp-connect__badge">
                {badge.label}
              </span>
            ))}
          </div>

          {/* 1. Install + start the server */}
          <section className="mcp-connect__section" aria-label="Install and start server">
            <p className="mcp-connect__section-label">1. Install &amp; start the MCP server</p>
            <div className="mcp-connect__code-row">
              <pre className="mcp-connect__code">
                <code>{SERVER_INSTALL_CMD}</code>
              </pre>
              <CopyButton text={SERVER_INSTALL_CMD} label="install and start command" />
            </div>
            <p className="mcp-connect__hint mcp-connect__hint--inline">
              If the server is already installed, use:{' '}
              <code className="mcp-connect__inline-code">{SERVER_START_CMD}</code>
            </p>
          </section>

          {/* 2. Endpoint URL */}
          <section className="mcp-connect__section" aria-label="Endpoint URL">
            <p className="mcp-connect__section-label">2. MCP endpoint</p>
            <div className="mcp-connect__code-row">
              <pre className="mcp-connect__code">
                <code>{ENDPOINT_URL}</code>
              </pre>
              <CopyButton text={ENDPOINT_URL} label="endpoint URL" />
            </div>
            <p className="mcp-connect__hint mcp-connect__hint--inline">
              Point your MCP client (Claude Desktop, Cursor, etc.) at this URL.
              Set <code className="mcp-connect__inline-code">MCP_AUTH_TOKEN</code> to protect the endpoint in production.
            </p>
          </section>

          {/* 3. Agent loop */}
          <McpAgentLoop />
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// McpConnectButton — launcher for the StatusBar
// ---------------------------------------------------------------------------

export function McpConnectButton(): React.ReactElement {
  const [open, setOpen] = useState(false);
  // Ref to the trigger button so we can restore focus on close.
  const triggerRef = useRef<HTMLButtonElement>(null);

  const handleOpen = useCallback(() => setOpen(true), []);

  const handleClose = useCallback(() => {
    setOpen(false);
    // Restore focus to the trigger after the next paint.
    setTimeout(() => triggerRef.current?.focus(), 0);
  }, []);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="mcp-connect-trigger"
        onClick={handleOpen}
        aria-label="Connect an MCP agent"
        title="Connect an MCP agent"
      >
        Connect agent
      </button>

      {open && <McpConnect onClose={handleClose} />}
    </>
  );
}
