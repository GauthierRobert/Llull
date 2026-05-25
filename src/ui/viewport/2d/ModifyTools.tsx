/**
 * @layer ui/viewport/2d
 *
 * Modify-tool palette for the 2D drafting viewport.
 *
 * Renders as an HTML overlay inside the viewport container (not inside the
 * r3f Canvas). Provides accessible buttons for each modify tool, plus a
 * minimal numeric input for tools that need a distance / radius.
 *
 * Presentation only — no document mutations (R1). All state changes go
 * through the passed callbacks.
 */

import React, { useCallback, useRef, useEffect } from 'react';
import type { ModifyToolKind, ModifyToolPhase } from './useModifyTool';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface ModifyToolsProps {
  activeTool: ModifyToolKind;
  phase: ModifyToolPhase;
  pendingValue: number;
  onSelectTool: (tool: ModifyToolKind) => void;
  onSetValue: (v: number) => void;
  onCommitValue: () => void;
}

// ---------------------------------------------------------------------------
// Icons
// ---------------------------------------------------------------------------

const OFFSET_ICON = (
  <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
    <path d="M4 14 L14 14" />
    <path d="M6 10 L16 10" strokeDasharray="2 2" opacity="0.5" />
    <path d="M4 8 L4 12 M14 8 L14 16" strokeWidth="1.5" opacity="0.6" />
  </svg>
);

const FILLET_ICON = (
  <svg
    viewBox="0 0 20 20"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M3 17 L3 8 Q3 3 8 3 L17 3" />
  </svg>
);

const CHAMFER_ICON = (
  <svg
    viewBox="0 0 20 20"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M3 17 L3 8 L8 3 L17 3" />
  </svg>
);

const TRIM_ICON = (
  <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
    <line x1="3" y1="10" x2="17" y2="10" />
    <line x1="10" y1="3" x2="10" y2="8" />
    <line x1="10" y1="12" x2="10" y2="17" strokeDasharray="2 2" opacity="0.4" />
  </svg>
);

const EXTEND_ICON = (
  <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
    <line x1="3" y1="10" x2="17" y2="10" />
    <line x1="10" y1="3" x2="10" y2="11" />
    <line x1="8" y1="9" x2="10" y2="11" strokeWidth="1.5" />
    <line x1="12" y1="9" x2="10" y2="11" strokeWidth="1.5" />
  </svg>
);

const EXPLODE_ICON = (
  <svg
    viewBox="0 0 20 20"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <polyline points="3,10 7,5 13,14 17,9" opacity="0.4" />
    <line x1="3" y1="10" x2="7" y2="5" />
    <line x1="7" y1="5" x2="13" y2="14" />
    <line x1="13" y1="14" x2="17" y2="9" />
  </svg>
);

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

interface ToolButton {
  tool: ModifyToolKind;
  label: string;
  hint: string;
  icon: React.ReactNode;
}

const TOOL_BUTTONS: ToolButton[] = [
  { tool: 'offset', label: 'Offset', hint: 'O', icon: OFFSET_ICON },
  { tool: 'fillet', label: 'Fillet', hint: 'F', icon: FILLET_ICON },
  { tool: 'chamfer', label: 'Chamfer', hint: 'K', icon: CHAMFER_ICON },
  { tool: 'trim', label: 'Trim', hint: 'T', icon: TRIM_ICON },
  { tool: 'extend', label: 'Extend', hint: 'X', icon: EXTEND_ICON },
  { tool: 'explode', label: 'Explode', hint: 'E', icon: EXPLODE_ICON },
];

// ---------------------------------------------------------------------------
// Phase hints
// ---------------------------------------------------------------------------

function phaseHint(tool: ModifyToolKind, phase: ModifyToolPhase): string | null {
  if (phase === 'idle' || tool === 'none') return null;
  switch (tool) {
    case 'explode':
      return 'Click a polyline to explode.';
    case 'offset':
      if (phase === 'pick-entity') return 'Click an entity to offset.';
      if (phase === 'enter-value') return 'Enter offset distance, then press Enter.';
      return null;
    case 'trim':
      if (phase === 'pick-entity') return 'Click the line to trim.';
      if (phase === 'pick-boundary') return 'Click the boundary line.';
      return null;
    case 'extend':
      if (phase === 'pick-entity') return 'Click the line to extend.';
      if (phase === 'pick-boundary') return 'Click the boundary line.';
      return null;
    case 'fillet':
      if (phase === 'pick-entity') return 'Click a polyline to fillet.';
      if (phase === 'pick-vertex') return 'Click near a vertex to fillet.';
      if (phase === 'enter-value') return 'Enter fillet radius, then press Enter.';
      return null;
    case 'chamfer':
      if (phase === 'pick-entity') return 'Click a polyline to chamfer.';
      if (phase === 'pick-vertex') return 'Click near a vertex to chamfer.';
      if (phase === 'enter-value') return 'Enter chamfer distance, then press Enter.';
      return null;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Value label (for the numeric input)
// ---------------------------------------------------------------------------

function valueLabel(tool: ModifyToolKind): string {
  if (tool === 'fillet') return 'Radius';
  if (tool === 'offset') return 'Distance';
  return 'Distance';
}

// ---------------------------------------------------------------------------
// ModifyTools component
// ---------------------------------------------------------------------------

export function ModifyTools({
  activeTool,
  phase,
  pendingValue,
  onSelectTool,
  onSetValue,
  onCommitValue,
}: ModifyToolsProps): React.ReactElement {
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Auto-focus the input when the enter-value phase begins.
  useEffect(() => {
    if (phase === 'enter-value' && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [phase]);

  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const v = parseFloat(e.target.value);
      if (!isNaN(v)) onSetValue(v);
    },
    [onSetValue],
  );

  const handleInputKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        onCommitValue();
      }
    },
    [onCommitValue],
  );

  const hint = phaseHint(activeTool, phase);

  return (
    <div className="modify-tools" role="toolbar" aria-label="2D modify tools">
      {TOOL_BUTTONS.map(({ tool, label, hint: kbHint, icon }) => (
        <button
          key={tool}
          className={`draw-tool-btn${activeTool === tool ? ' draw-tool-btn--active' : ''}`}
          onClick={() => onSelectTool(activeTool === tool ? 'none' : tool)}
          aria-pressed={activeTool === tool}
          title={`${label} (${kbHint})`}
          aria-label={label}
        >
          <span className="draw-tool-icon" aria-hidden="true">
            {icon}
          </span>
          <span className="draw-tool-label">{label}</span>
        </button>
      ))}

      {hint && (
        <div className="draw-tool-hint" role="status" aria-live="polite">
          {hint}
        </div>
      )}

      {phase === 'enter-value' && (
        <div className="modify-tool-input-row">
          <label className="modify-tool-input-label" htmlFor="modify-value-input">
            {valueLabel(activeTool)}
          </label>
          <input
            id="modify-value-input"
            ref={inputRef}
            className="modify-tool-input"
            type="number"
            min={0.001}
            step={0.1}
            value={pendingValue}
            onChange={handleInputChange}
            onKeyDown={handleInputKeyDown}
            aria-label={`${valueLabel(activeTool)} value`}
          />
          <button
            className="modify-tool-commit-btn"
            onClick={onCommitValue}
            aria-label="Apply"
          >
            Apply
          </button>
        </div>
      )}
    </div>
  );
}
