/**
 * @layer ui/viewport/2d
 *
 * Tool palette for the 2D drafting viewport.
 *
 * Renders as an HTML overlay inside the viewport container (not inside the
 * r3f Canvas). Provides accessible buttons for each draw tool.
 *
 * Presentation only — no document mutations (R1). All state changes go
 * through the passed callbacks.
 */

import React from 'react';
import { Icon } from '@ui/components/Icon';
import type { IconName } from '@ui/components/Icon';
import type { DrawToolKind } from './useDrawTool';

interface DrawToolsProps {
  activeTool: DrawToolKind;
  onSelectTool: (tool: DrawToolKind) => void;
}

interface ToolButton {
  tool: DrawToolKind;
  label: string;
  /** Short keyboard hint shown in tooltip. */
  hint: string;
  icon: IconName;
}

const TOOL_BUTTONS: ToolButton[] = [
  { tool: 'none', label: 'Select', hint: 'Esc', icon: 'cursor' },
  { tool: 'line', label: 'Line', hint: 'L', icon: 'drawLine' },
  { tool: 'polyline', label: 'Polyline', hint: 'P', icon: 'drawPolyline' },
  { tool: 'circle', label: 'Circle', hint: 'C', icon: 'drawCircle' },
  { tool: 'ellipse', label: 'Ellipse', hint: 'E', icon: 'drawEllipse' },
  { tool: 'rectangle', label: 'Rectangle', hint: 'R', icon: 'drawRectangle' },
  { tool: 'spline', label: 'Spline', hint: 'S', icon: 'drawSpline' },
  { tool: 'point', label: 'Point', hint: '.', icon: 'drawPoint' },
];

const TOOL_HINTS: Partial<Record<DrawToolKind, string>> = {
  polyline: 'Click to add points. Enter to finish, Esc to cancel.',
  spline: 'Click to add through-points. Enter or double-click to finish, Esc to cancel.',
  line: 'Click start, then end point.',
  circle: 'Click center, then radius point.',
  ellipse: 'Click center, then a corner of the bounding box.',
  rectangle: 'Click two opposite corners.',
  point: 'Click to place a point.',
};

export function DrawTools({ activeTool, onSelectTool }: DrawToolsProps): React.ReactElement {
  const hint = TOOL_HINTS[activeTool];
  return (
    <>
      <div
        className="vp-tool-palette vp-tool-palette--draw"
        role="toolbar"
        aria-label="2D draw tools"
      >
        {TOOL_BUTTONS.map(({ tool, label, hint: keyHint, icon }, index) => (
          <React.Fragment key={tool}>
            <button
              type="button"
              className={`draw-tool-btn${activeTool === tool ? ' draw-tool-btn--active' : ''}`}
              onClick={() => onSelectTool(tool)}
              aria-pressed={activeTool === tool}
              title={`${label} (${keyHint})`}
              aria-label={label}
            >
              <Icon name={icon} size={16} />
            </button>
            {index === 0 && (
              <span className="vp-divider vp-divider--horizontal" aria-hidden="true" />
            )}
          </React.Fragment>
        ))}
      </div>
      {hint && (
        <div className="vp-hint" role="status" aria-live="polite">
          {hint}
        </div>
      )}
    </>
  );
}
