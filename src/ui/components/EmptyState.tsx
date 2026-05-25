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
 * Viewer mode: this is a read-only mirror of the MCP-driven document. The copy
 * reflects that Claude drives the model, the human watches it render.
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
  if (entityCount > 0 || dismissed) return null;

  return (
    <div
      className="empty-state"
      role="status"
      aria-label="Waiting for MCP agent"
      aria-live="polite"
    >
      <div className="empty-state__card">
        <button
          type="button"
          className="empty-state__dismiss"
          onClick={() => setDismissed(true)}
          aria-label="Dismiss hint"
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
            <circle cx="20" cy="20" r="3" stroke="currentColor" strokeWidth="1.5" />
            <path
              d="M20 10v4M20 26v4M10 20h4M26 20h4"
              stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"
            />
          </svg>
        </div>

        <h2 className="empty-state__heading">Waiting for your MCP agent</h2>
        <p className="empty-state__subheading">
          Ask Claude to build something and it appears here.
        </p>

        <ul className="empty-state__tips" aria-label="Viewer tips">
          <li className="empty-state__tip">
            <span className="empty-state__tip-icon" aria-hidden="true">&#x2192;</span>
            Claude drives this canvas over MCP — describe a model and watch it render.
          </li>
          <li className="empty-state__tip">
            <span className="empty-state__tip-icon" aria-hidden="true">&#x25CB;</span>
            Click any entity to inspect its properties in the left panel.
          </li>
          <li className="empty-state__tip">
            <span className="empty-state__tip-icon" aria-hidden="true">&#x2715;</span>
            Switch between <strong>2D</strong> and <strong>3D</strong> with the
            toggle above the viewport.
          </li>
        </ul>
      </div>
    </div>
  );
}
