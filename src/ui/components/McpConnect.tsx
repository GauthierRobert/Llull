/**
 * @layer ui/components
 *
 * McpConnect — modal dialog showing how to connect an MCP agent (McpConnectButton in the TopBar
 * opens it). Focus is trapped while open and restored to the trigger on close.
 * Presentation ONLY (PRIME DIRECTIVE).
 */

import React, { useEffect, useId, useRef, useState } from 'react';
import { SERVER_BASE } from '@ui/serverConfig';
import { Icon } from '@ui/components/Icon';
import { focusableElements, trapTab } from '@ui/focusTrap';

const SERVER_INSTALL_CMD = 'npm --prefix server install && npm --prefix server run dev';
const SERVER_START_CMD = 'npm --prefix server run dev';
const ENDPOINT_URL = `${SERVER_BASE}/mcp`;

const CAPABILITY_BADGES: readonly string[] = [
  '60 tools',
  'structuredContent',
  'prompts (EN2)',
  'session isolation',
];

interface AgentLoopStep {
  readonly tool: string;
  readonly description: string;
}

const AGENT_LOOP_STEPS: readonly AgentLoopStep[] = [
  {
    tool: 'read cad://conventions',
    description:
      'Load the llull conventions resource to understand coordinate axes, units, and entity kinds.',
  },
  {
    tool: 'describe_scene',
    description: 'Inspect the current document: all entities, layers, and their properties.',
  },
  {
    tool: 'add_box (or any create/edit command)',
    description:
      'Create or modify geometry via any registered command (add_box, draw_line, extrude_profile, …).',
  },
  {
    tool: 'render_view',
    description:
      'Render a screenshot with axes, grid, units, and showLabels:true to verify the result visually.',
  },
  {
    tool: 'check_model',
    description: 'Validate the model (watertight, no self-intersections) after modifications.',
  },
];

interface CopyButtonProps {
  readonly text: string;
  readonly label: string;
}

function CopyButton({ text, label }: CopyButtonProps): React.ReactElement {
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (resetTimer.current !== null) clearTimeout(resetTimer.current);
    },
    [],
  );

  const handleCopy = (): void => {
    navigator.clipboard.writeText(text).then(
      () => {
        setCopied(true);
        if (resetTimer.current !== null) clearTimeout(resetTimer.current);
        resetTimer.current = setTimeout(() => setCopied(false), 1800);
      },
      () => setCopied(false),
    );
  };

  return (
    <button
      type="button"
      className={`icon-btn mcp-connect__copy-btn${copied ? ' mcp-connect__copy-btn--copied' : ''}`}
      onClick={handleCopy}
      aria-label={copied ? `${label} copied` : `Copy ${label}`}
      title={copied ? 'Copied!' : `Copy ${label}`}
    >
      <Icon name={copied ? 'check' : 'copy'} size={14} />
    </button>
  );
}

interface ConnectStepProps {
  readonly step: number;
  readonly ariaLabel: string;
  readonly label: React.ReactNode;
  readonly children: React.ReactNode;
}

function ConnectStep({ step, ariaLabel, label, children }: ConnectStepProps): React.ReactElement {
  return (
    <section className="mcp-connect__section" aria-label={ariaLabel}>
      <span className="mcp-connect__step-num" aria-hidden="true">
        {step}
      </span>
      <p className="mcp-connect__section-label">{label}</p>
      {children}
    </section>
  );
}

function CodeRow({ code, copyLabel }: { code: string; copyLabel: string }): React.ReactElement {
  return (
    <div className="mcp-connect__code-row">
      <pre className="mcp-connect__code">
        <code>{code}</code>
      </pre>
      <CopyButton text={code} label={copyLabel} />
    </div>
  );
}

function McpAgentLoop(): React.ReactElement {
  return (
    <ConnectStep step={3} ariaLabel="Recommended agent loop" label="Recommended agent loop">
      <ol className="mcp-connect__loop-list">
        {AGENT_LOOP_STEPS.map((step) => (
          <li key={step.tool} className="mcp-connect__loop-item">
            <div className="mcp-connect__loop-tool-row">
              <code className="mcp-connect__loop-tool">{step.tool}</code>
              <CopyButton text={step.tool} label={`${step.tool} tool name`} />
            </div>
            <p className="mcp-connect__loop-desc">{step.description}</p>
          </li>
        ))}
      </ol>
    </ConnectStep>
  );
}

interface McpConnectProps {
  /** Called when the dialog requests close (Esc, backdrop click, close button). */
  readonly onClose: () => void;
}

export function McpConnect({ onClose }: McpConnectProps): React.ReactElement {
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  // Focus the first focusable element when the modal opens.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog) focusableElements(dialog, { links: true })[0]?.focus();
  }, []);

  return (
    <div
      className="mcp-connect-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      aria-hidden="false"
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="mcp-connect"
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            onClose();
          } else if (e.key === 'Tab' && dialogRef.current) {
            trapTab(e, dialogRef.current, { links: true });
          }
        }}
      >
        <div className="mcp-connect__header">
          <span className="mcp-connect__header-icon" aria-hidden="true">
            <Icon name="plug" size={16} />
          </span>
          <div className="mcp-connect__heading">
            <h2 id={titleId} className="mcp-connect__title">
              Connect an MCP agent
            </h2>
            <p className="mcp-connect__subtitle">Let Claude or any MCP client drive this canvas.</p>
          </div>
          <button
            type="button"
            className="icon-btn mcp-connect__close"
            onClick={onClose}
            aria-label="Close dialog"
            title="Close"
          >
            <Icon name="close" size={14} />
          </button>
        </div>

        <div className="mcp-connect__body">
          <div className="mcp-connect__badges" aria-label="Capabilities">
            {CAPABILITY_BADGES.map((badge) => (
              <span key={badge} className="mcp-connect__badge">
                {badge}
              </span>
            ))}
          </div>

          <ConnectStep
            step={1}
            ariaLabel="Install and start server"
            label="Install & start the MCP server"
          >
            <CodeRow code={SERVER_INSTALL_CMD} copyLabel="install and start command" />
            <p className="mcp-connect__hint mcp-connect__hint--inline">
              If the server is already installed, use:{' '}
              <code className="mcp-connect__inline-code">{SERVER_START_CMD}</code>
            </p>
          </ConnectStep>

          <ConnectStep step={2} ariaLabel="Endpoint URL" label="MCP endpoint">
            <CodeRow code={ENDPOINT_URL} copyLabel="endpoint URL" />
            <p className="mcp-connect__hint mcp-connect__hint--inline">
              Point your MCP client (Claude Desktop, Cursor, etc.) at this URL. Set{' '}
              <code className="mcp-connect__inline-code">MCP_AUTH_TOKEN</code> to protect the
              endpoint in production.
            </p>
          </ConnectStep>

          <McpAgentLoop />
        </div>
      </div>
    </div>
  );
}

export function McpConnectButton(): React.ReactElement {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const handleClose = (): void => {
    setOpen(false);
    // Restore focus to the trigger after the next paint.
    setTimeout(() => triggerRef.current?.focus(), 0);
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="mcp-connect-trigger"
        onClick={() => setOpen(true)}
        aria-label="Connect agent"
        title="Connect an MCP agent"
      >
        <Icon name="plug" size={14} />
        <span>Connect agent</span>
      </button>

      {open && <McpConnect onClose={handleClose} />}
    </>
  );
}
