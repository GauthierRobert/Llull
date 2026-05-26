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

const SERVER_START_CMD = 'npm --prefix server run dev';
const ENDPOINT_URL = 'http://localhost:3000/mcp';

interface CapabilityBadge {
  readonly label: string;
}

const CAPABILITY_BADGES: readonly CapabilityBadge[] = [
  { label: '60 tools' },
  { label: 'structuredContent (KI2)' },
  { label: 'prompts (EN2)' },
  { label: 'session isolation (KI1)' },
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

          {/* Start command */}
          <section className="mcp-connect__section" aria-label="Server start command">
            <p className="mcp-connect__section-label">Start the MCP server</p>
            <div className="mcp-connect__code-row">
              <pre className="mcp-connect__code">
                <code>{SERVER_START_CMD}</code>
              </pre>
              <CopyButton text={SERVER_START_CMD} label="start command" />
            </div>
          </section>

          {/* Endpoint URL */}
          <section className="mcp-connect__section" aria-label="Endpoint URL">
            <p className="mcp-connect__section-label">MCP endpoint</p>
            <div className="mcp-connect__code-row">
              <pre className="mcp-connect__code">
                <code>{ENDPOINT_URL}</code>
              </pre>
              <CopyButton text={ENDPOINT_URL} label="endpoint URL" />
            </div>
          </section>

          {/* Footer hint */}
          <p className="mcp-connect__hint">
            Point your MCP client (Claude Desktop, Cursor, etc.) at the endpoint above.
          </p>
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
