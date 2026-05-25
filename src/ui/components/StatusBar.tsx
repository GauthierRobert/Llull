/**
 * @layer ui/components
 *
 * StatusBar — a bottom bar that surfaces live document state at a glance.
 *
 * Reads (all via narrow Zustand selectors — react R3):
 *   - document.units + document.displayPrecision → formatted unit label
 *   - document.selection.length               → selection count
 *   - lastSummary                             → most recent command feedback
 *
 * Presentation ONLY. No document mutations (PRIME DIRECTIVE).
 *
 * TODO (U4): add live cursor coordinates once Lane 3's 2D cursor-tracking
 * hook is in place. The coordinates depend on the 2D pointer-move event
 * stream established by the Viewport2D interaction layer.
 */

import React from 'react';
import { useStore, useThemeStore } from '@ui/store';
import { McpConnectButton } from '@ui/components/McpConnect';

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

interface StatusItemProps {
  label: string;
  value: string;
  'aria-label'?: string;
}

function StatusItem({ label, value, 'aria-label': ariaLabel }: StatusItemProps): React.ReactElement {
  return (
    <span className="status-item" aria-label={ariaLabel ?? `${label}: ${value}`}>
      <span className="status-item__label">{label}</span>
      <span className="status-item__value">{value}</span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// ThemeToggle
// ---------------------------------------------------------------------------

function ThemeToggle(): React.ReactElement {
  const theme = useThemeStore((s) => s.theme);
  const toggleTheme = useThemeStore((s) => s.toggleTheme);

  return (
    <button
      type="button"
      className="status-theme-toggle"
      onClick={toggleTheme}
      aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
      title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
    >
      {theme === 'dark' ? '☀' : '☾'}
    </button>
  );
}

// ---------------------------------------------------------------------------
// StatusBar
// ---------------------------------------------------------------------------

export function StatusBar(): React.ReactElement {
  const units = useStore((s) => s.document.units);
  const displayPrecision = useStore((s) => s.document.displayPrecision);
  const selectionCount = useStore((s) => s.document.selection.length);
  const lastSummary = useStore((s) => s.lastSummary);

  const unitLabel = `${units} (${displayPrecision}dp)`;
  const selectionLabel = selectionCount === 0
    ? 'None'
    : selectionCount === 1
      ? '1 entity'
      : `${selectionCount} entities`;

  return (
    <footer className="status-bar-bottom" aria-label="Document status">
      <div className="status-bar-bottom__items">
        <StatusItem label="Units" value={unitLabel} aria-label={`Units: ${unitLabel}`} />
        <span className="status-divider" aria-hidden="true" />
        <StatusItem
          label="Selection"
          value={selectionLabel}
          aria-label={`Selection: ${selectionLabel}`}
        />
        {lastSummary !== null && (
          <>
            <span className="status-divider" aria-hidden="true" />
            <span
              className="status-summary"
              aria-live="polite"
              aria-label={`Last command: ${lastSummary}`}
            >
              {lastSummary}
            </span>
          </>
        )}
      </div>
      <div className="status-bar-bottom__right">
        <McpConnectButton />
        <ThemeToggle />
      </div>
    </footer>
  );
}
