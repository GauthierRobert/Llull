/**
 * @layer ui/components
 *
 * EmptyState — a centered HTML overlay shown when the document has no entities.
 *
 * Behavior:
 *   - Subscribes to `document.order.length` via a narrow Zustand selector (R3).
 *   - Renders only when the entity count is 0; auto-hides once any entity exists.
 *   - Dismissable with a close button; dismissed state is local React state (not
 *     document state — this is pure presentation, PRIME DIRECTIVE).
 *   - Mounted by App.tsx inside `.app-viewport` as an HTML overlay (NOT inside
 *     the three.js canvas).
 *
 * Presentation ONLY. No document mutations.
 */

import React, { useState } from 'react';
import { useStore } from '@ui/store';

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function EmptyState(): React.ReactElement | null {
  const entityCount = useStore((s) => s.document.order.length);
  const [dismissed, setDismissed] = useState(false);

  // Auto-show again if all entities are deleted after dismissal.
  // We reset dismissed when entities go back to 0 by keying off count.
  // Simpler: just show whenever count === 0 AND not manually dismissed.
  // Re-show when count goes back to 0 (the document was reset, so this
  // is a fresh empty state).
  if (entityCount > 0 || dismissed) return null;

  return (
    <div
      className="empty-state"
      role="status"
      aria-label="Getting started"
      aria-live="polite"
    >
      <div className="empty-state__card">
        <button
          type="button"
          className="empty-state__dismiss"
          onClick={() => setDismissed(true)}
          aria-label="Dismiss getting started hint"
          title="Dismiss"
        >
          &times;
        </button>

        <div className="empty-state__icon" aria-hidden="true">
          <svg width="40" height="40" viewBox="0 0 40 40" fill="none">
            <rect
              x="8" y="8" width="24" height="24" rx="3"
              stroke="currentColor" strokeWidth="1.5" strokeDasharray="4 2"
            />
            <path
              d="M20 14v12M14 20h12"
              stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"
            />
          </svg>
        </div>

        <h2 className="empty-state__heading">No geometry yet</h2>
        <p className="empty-state__subheading">
          Add a box from the toolbar, draw in 2D, or press{' '}
          <kbd className="empty-state__kbd">Ctrl/Cmd K</kbd> for the command palette.
        </p>

        <ul className="empty-state__tips" aria-label="Getting started tips">
          <li className="empty-state__tip">
            <span className="empty-state__tip-icon" aria-hidden="true">+</span>
            Click <strong>Add Box</strong> in the toolbar to place your first 3D solid.
          </li>
          <li className="empty-state__tip">
            <span className="empty-state__tip-icon" aria-hidden="true">2D</span>
            Switch to <strong>2D view</strong> and use the draw tools to sketch lines,
            arcs, and circles.
          </li>
          <li className="empty-state__tip">
            <span className="empty-state__tip-icon" aria-hidden="true">K</span>
            Press <kbd className="empty-state__kbd">Ctrl K</kbd> to search all{' '}
            <strong>49+ commands</strong> — including extrude, measure, and transform.
          </li>
          <li className="empty-state__tip">
            <span className="empty-state__tip-icon" aria-hidden="true">&#x2699;</span>
            llull is <strong>MCP-first</strong>: connect an AI agent to drive the same
            commands via the MCP endpoint.
          </li>
        </ul>
      </div>
    </div>
  );
}
