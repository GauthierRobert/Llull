/**
 * @layer ui/components
 *
 * McpConnect — informational modal explaining how to connect an MCP agent.
 *
 * Content (accurate, no network calls):
 *   - MCP endpoint: http://localhost:3001/mcp
 *   - Start command: npm --prefix server run dev
 *   - Resources: cad://document, cad://scene, cad://selection
 *   - Tools/commands: same registry as the UI (49+ tools)
 *
 * Accessibility:
 *   - role="dialog", aria-modal, aria-labelledby
 *   - Esc closes; focus trap (Tab/Shift+Tab stays within dialog)
 *   - Focus restored to the trigger element on close (R10)
 *   - Backdrop click closes
 *
 * Presentation ONLY. No fetch, no connection logic. PRIME DIRECTIVE.
 *
 * McpConnectButton — the trigger button placed in the status bar area.
 */

import React, {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';

// ---------------------------------------------------------------------------
// McpConnect modal
// ---------------------------------------------------------------------------

export interface McpConnectProps {
  isOpen: boolean;
  onClose: () => void;
}

const MCP_ENDPOINT = 'http://localhost:3001/mcp';
const MCP_START_CMD = 'npm --prefix server run dev';

/** Copy text to the clipboard; falls back silently if the API is unavailable. */
function copyToClipboard(text: string): void {
  if (typeof navigator !== 'undefined' && navigator.clipboard) {
    void navigator.clipboard.writeText(text);
  }
}

export function McpConnect({ isOpen, onClose }: McpConnectProps): React.ReactElement | null {
  const uid = useId();
  const titleId = `${uid}-title`;

  const dialogRef = useRef<HTMLDivElement>(null);
  const priorFocusRef = useRef<Element | null>(null);
  const [endpointCopied, setEndpointCopied] = useState(false);
  const [cmdCopied, setCmdCopied] = useState(false);

  // Focus management: save + restore, auto-focus dialog on open.
  useEffect(() => {
    if (isOpen) {
      priorFocusRef.current = document.activeElement;
      requestAnimationFrame(() => {
        dialogRef.current?.focus();
      });
    } else {
      const prior = priorFocusRef.current;
      if (prior && prior instanceof HTMLElement && document.contains(prior)) {
        prior.focus();
      }
      priorFocusRef.current = null;
    }
  }, [isOpen]);

  // Reset copy states when modal closes.
  useEffect(() => {
    if (!isOpen) {
      setEndpointCopied(false);
      setCmdCopied(false);
    }
  }, [isOpen]);

  const handleClose = useCallback(() => {
    onClose();
  }, [onClose]);

  const handleBackdropClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === e.currentTarget) handleClose();
    },
    [handleClose],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        handleClose();
        return;
      }

      // Focus trap.
      if (e.key === 'Tab') {
        const dialog = dialogRef.current;
        if (!dialog) return;
        const focusable = Array.from(
          dialog.querySelectorAll<HTMLElement>(
            'button:not([disabled]), a:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
          ),
        );
        if (focusable.length === 0) {
          e.preventDefault();
          return;
        }
        const first = focusable[0]!;
        const last = focusable[focusable.length - 1]!;
        if (e.shiftKey) {
          if (document.activeElement === first) {
            e.preventDefault();
            last.focus();
          }
        } else {
          if (document.activeElement === last) {
            e.preventDefault();
            first.focus();
          }
        }
      }
    },
    [handleClose],
  );

  const handleCopyEndpoint = useCallback(() => {
    copyToClipboard(MCP_ENDPOINT);
    setEndpointCopied(true);
    setTimeout(() => setEndpointCopied(false), 1500);
  }, []);

  const handleCopyCmd = useCallback(() => {
    copyToClipboard(MCP_START_CMD);
    setCmdCopied(true);
    setTimeout(() => setCmdCopied(false), 1500);
  }, []);

  if (!isOpen) return null;

  return (
    <div
      className="mcp-backdrop"
      onClick={handleBackdropClick}
      aria-hidden={!isOpen}
    >
      <div
        ref={dialogRef}
        className="mcp-dialog"
        role="dialog"
        aria-modal
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={handleKeyDown}
      >
        {/* Header */}
        <div className="mcp-header">
          <h2 id={titleId} className="mcp-title">Connect an MCP Agent</h2>
          <button
            type="button"
            className="mcp-close-btn"
            onClick={handleClose}
            aria-label="Close MCP connect dialog"
          >
            &times;
          </button>
        </div>

        {/* Body */}
        <div className="mcp-body">
          <p className="mcp-description">
            llull is <strong>MCP-first</strong>: every command in the UI is also
            a tool that any MCP-compatible agent (Claude, Cursor, or any custom
            client) can call. The agent drives the exact same command registry —
            49+ tools, resources, and prompts.
          </p>

          {/* Step 1 — start the host */}
          <div className="mcp-step">
            <span className="mcp-step__num" aria-hidden="true">1</span>
            <div className="mcp-step__content">
              <p className="mcp-step__label">Start the MCP host</p>
              <div className="mcp-code-row">
                <code className="mcp-code">{MCP_START_CMD}</code>
                <button
                  type="button"
                  className="mcp-copy-btn"
                  onClick={handleCopyCmd}
                  aria-label={cmdCopied ? 'Copied start command' : 'Copy start command to clipboard'}
                  title="Copy"
                >
                  {cmdCopied ? 'Copied' : 'Copy'}
                </button>
              </div>
            </div>
          </div>

          {/* Step 2 — point your client */}
          <div className="mcp-step">
            <span className="mcp-step__num" aria-hidden="true">2</span>
            <div className="mcp-step__content">
              <p className="mcp-step__label">Point your MCP client at the endpoint</p>
              <div className="mcp-code-row">
                <code className="mcp-code">{MCP_ENDPOINT}</code>
                <button
                  type="button"
                  className="mcp-copy-btn"
                  onClick={handleCopyEndpoint}
                  aria-label={endpointCopied ? 'Copied endpoint' : 'Copy endpoint URL to clipboard'}
                  title="Copy"
                >
                  {endpointCopied ? 'Copied' : 'Copy'}
                </button>
              </div>
            </div>
          </div>

          {/* What's exposed */}
          <div className="mcp-section">
            <p className="mcp-section__label">What the agent can access</p>
            <ul className="mcp-list" aria-label="MCP capabilities">
              <li className="mcp-list__item">
                <span className="mcp-badge mcp-badge--tools">Tools</span>
                All 49+ CAD commands — add box, draw line, extrude, measure, transform, and more.
              </li>
              <li className="mcp-list__item">
                <span className="mcp-badge mcp-badge--resources">Resources</span>
                <code className="mcp-inline-code">cad://document</code>,{' '}
                <code className="mcp-inline-code">cad://scene</code>,{' '}
                <code className="mcp-inline-code">cad://selection</code>
              </li>
              <li className="mcp-list__item">
                <span className="mcp-badge mcp-badge--prompts">Prompts</span>
                Guided workflows for common modeling tasks.
              </li>
            </ul>
          </div>
        </div>

        {/* Footer */}
        <div className="mcp-footer">
          <button type="button" className="mcp-done-btn" onClick={handleClose}>
            Got it
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// McpConnectButton — trigger button (placed in the status bar area)
// ---------------------------------------------------------------------------

export function McpConnectButton(): React.ReactElement {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        className="mcp-trigger-btn"
        onClick={() => setOpen(true)}
        aria-label="Connect an MCP agent to llull"
        title="Connect an MCP agent"
      >
        MCP
      </button>

      <McpConnect isOpen={open} onClose={() => setOpen(false)} />
    </>
  );
}
