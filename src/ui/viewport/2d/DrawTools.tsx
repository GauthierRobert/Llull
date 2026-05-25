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
  /** SVG path data for the icon. */
  icon: React.ReactNode;
}

const LINE_ICON = (
  <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
    <line x1="3" y1="17" x2="17" y2="3" />
  </svg>
);

const POLYLINE_ICON = (
  <svg
    viewBox="0 0 20 20"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <polyline points="3,17 7,7 13,12 17,4" />
  </svg>
);

const CIRCLE_ICON = (
  <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2">
    <circle cx="10" cy="10" r="7" />
  </svg>
);

const RECT_ICON = (
  <svg
    viewBox="0 0 20 20"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <rect x="3" y="5" width="14" height="10" />
  </svg>
);

const POINT_ICON = (
  <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2">
    <circle cx="10" cy="10" r="2.5" fill="currentColor" />
    <line x1="10" y1="3" x2="10" y2="6" />
    <line x1="10" y1="14" x2="10" y2="17" />
    <line x1="3" y1="10" x2="6" y2="10" />
    <line x1="14" y1="10" x2="17" y2="10" />
  </svg>
);

const SELECT_ICON = (
  <svg
    viewBox="0 0 20 20"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M4 4 L4 15 L8 11 L11 17 L13 16 L10 10 L15 10 Z" />
  </svg>
);

const ELLIPSE_ICON = (
  <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2">
    <ellipse cx="10" cy="10" rx="7" ry="4" />
  </svg>
);

const SPLINE_ICON = (
  <svg
    viewBox="0 0 20 20"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    {/* Smooth S-curve to suggest a free-form spline */}
    <path d="M3 15 C5 15 6 5 10 5 C14 5 15 15 17 15" />
  </svg>
);

const TOOL_BUTTONS: ToolButton[] = [
  { tool: 'none', label: 'Select', hint: 'Esc', icon: SELECT_ICON },
  { tool: 'line', label: 'Line', hint: 'L', icon: LINE_ICON },
  { tool: 'polyline', label: 'Polyline', hint: 'P', icon: POLYLINE_ICON },
  { tool: 'circle', label: 'Circle', hint: 'C', icon: CIRCLE_ICON },
  { tool: 'ellipse', label: 'Ellipse', hint: 'E', icon: ELLIPSE_ICON },
  { tool: 'rectangle', label: 'Rectangle', hint: 'R', icon: RECT_ICON },
  { tool: 'spline', label: 'Spline', hint: 'S', icon: SPLINE_ICON },
  { tool: 'point', label: 'Point', hint: '.', icon: POINT_ICON },
];

export function DrawTools({ activeTool, onSelectTool }: DrawToolsProps): React.ReactElement {
  return (
    <div className="draw-tools" role="toolbar" aria-label="2D draw tools">
      {TOOL_BUTTONS.map(({ tool, label, hint, icon }) => (
        <button
          key={tool}
          className={`draw-tool-btn${activeTool === tool ? ' draw-tool-btn--active' : ''}`}
          onClick={() => onSelectTool(tool)}
          aria-pressed={activeTool === tool}
          title={`${label} (${hint})`}
          aria-label={label}
        >
          <span className="draw-tool-icon" aria-hidden="true">
            {icon}
          </span>
          <span className="draw-tool-label">{label}</span>
        </button>
      ))}

      {activeTool === 'polyline' && (
        <div className="draw-tool-hint" role="status" aria-live="polite">
          Click to add points. Enter to finish, Esc to cancel.
        </div>
      )}
      {activeTool === 'spline' && (
        <div className="draw-tool-hint" role="status" aria-live="polite">
          Click to add through-points. Enter or double-click to finish, Esc to cancel.
        </div>
      )}
      {activeTool === 'line' && (
        <div className="draw-tool-hint" role="status" aria-live="polite">
          Click start, then end point.
        </div>
      )}
      {activeTool === 'circle' && (
        <div className="draw-tool-hint" role="status" aria-live="polite">
          Click center, then radius point.
        </div>
      )}
      {activeTool === 'ellipse' && (
        <div className="draw-tool-hint" role="status" aria-live="polite">
          Click center, then a corner of the bounding box.
        </div>
      )}
      {activeTool === 'rectangle' && (
        <div className="draw-tool-hint" role="status" aria-live="polite">
          Click two opposite corners.
        </div>
      )}
      {activeTool === 'point' && (
        <div className="draw-tool-hint" role="status" aria-live="polite">
          Click to place a point.
        </div>
      )}
    </div>
  );
}
