/**
 * @layer ui/components
 *
 * EmptyState — a centered "start here" card over the viewport while the document has no entities.
 * Offers one-click starts (add a box, draw a rectangle) and explains how to move things and how to
 * let an MCP agent build the model. Auto-hides once any entity exists; dismissal is local state.
 * Actions only dispatch through the shared toolbar helpers (PRIME DIRECTIVE).
 */

import React, { useState } from 'react';
import { useStore, useToolStore } from '@ui/store';
import { PALETTE_SHORTCUT_LABEL } from '@ui/hooks/shortcuts';
import { Icon } from '@ui/components/Icon';
import { SOLID_PRESETS } from '@ui/components/toolbar/solidPresets';
import { createSolid } from '@ui/actions/createSolid';

export function EmptyState(): React.ReactElement | null {
  const entityCount = useStore((s) => s.document.order.length);
  const setDrawTool = useToolStore((s) => s.setDrawTool);
  const drawToolArmed = useToolStore((s) => s.drawTool !== 'none');
  const [dismissed, setDismissed] = useState(false);

  // Hidden while a 2D tool is armed so the card never covers the drawing area.
  if (entityCount > 0 || dismissed || drawToolArmed) return null;

  const boxPreset = SOLID_PRESETS[0];

  return (
    <div className="empty-state" role="region" aria-label="Get started">
      <div className="empty-state__card">
        <button
          type="button"
          className="icon-btn empty-state__dismiss"
          onClick={() => setDismissed(true)}
          aria-label="Dismiss hint"
          title="Dismiss"
        >
          <Icon name="close" size={14} />
        </button>

        <div className="empty-state__mark" aria-hidden="true">
          <Icon name="cube" size={22} />
        </div>

        <h2 className="empty-state__heading">Start your model</h2>
        <p className="empty-state__subheading">
          Everything you can create is in the toolbar above. Try one:
        </p>

        <div className="empty-state__actions">
          {boxPreset !== undefined && (
            <button
              type="button"
              className="empty-state__action"
              onClick={() => createSolid(boxPreset)}
            >
              <Icon name="cube" size={18} />
              <span className="empty-state__action-title">Add a 3D box</span>
              <span className="empty-state__action-sub">then drag its arrows to move it</span>
            </button>
          )}
          <button
            type="button"
            className="empty-state__action"
            onClick={() => setDrawTool('rectangle')}
          >
            <Icon name="drawRectangle" size={18} />
            <span className="empty-state__action-title">Draw a 2D rectangle</span>
            <span className="empty-state__action-sub">click two corners on the grid</span>
          </button>
        </div>

        <ul className="empty-state__tips" aria-label="Tips">
          <li className="empty-state__tip">
            <span className="empty-state__tip-icon" aria-hidden="true">
              <Icon name="transformMove" size={14} />
            </span>
            <span className="empty-state__tip-text">
              <strong>Move things:</strong> click an object, then drag the gizmo arrows (3D) or
              press <kbd className="kbd">M</kbd> (2D). Arrow keys nudge, the Properties panel takes
              exact coordinates.
            </span>
          </li>
          <li className="empty-state__tip">
            <span className="empty-state__tip-icon" aria-hidden="true">
              <Icon name="plug" size={14} />
            </span>
            <span className="empty-state__tip-text">
              <strong>Or let AI build it:</strong> use <em>Connect agent</em> (top right) and ask
              Claude to model something.
            </span>
          </li>
          <li className="empty-state__tip">
            <span className="empty-state__tip-icon" aria-hidden="true">
              <Icon name="search" size={14} />
            </span>
            <span className="empty-state__tip-text">
              Press <kbd className="kbd">{PALETTE_SHORTCUT_LABEL}</kbd> to search and run any of
              llull’s commands, or <kbd className="kbd">?</kbd> for keyboard shortcuts.
            </span>
          </li>
        </ul>
      </div>
    </div>
  );
}
