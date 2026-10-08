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

import React, { useRef, useEffect } from 'react';
import { Icon } from '@ui/components/Icon';
import type { IconName } from '@ui/components/Icon';
import type { ModifyToolKind } from '@ui/store';
import type { ModifyToolPhase } from './useModifyTool';

interface ModifyToolsProps {
  activeTool: ModifyToolKind;
  phase: ModifyToolPhase;
  pendingValue: number;
  onSelectTool: (tool: ModifyToolKind) => void;
  onSetValue: (v: number) => void;
  onCommitValue: () => void;
}

interface ToolButton {
  tool: ModifyToolKind;
  label: string;
  hint: string;
  icon: IconName;
}

const TOOL_BUTTONS: ToolButton[] = [
  { tool: 'offset', label: 'Offset', hint: 'O', icon: 'modifyOffset' },
  { tool: 'fillet', label: 'Fillet', hint: 'F', icon: 'modifyFillet' },
  { tool: 'chamfer', label: 'Chamfer', hint: 'K', icon: 'modifyChamfer' },
  { tool: 'trim', label: 'Trim', hint: 'T', icon: 'modifyTrim' },
  { tool: 'extend', label: 'Extend', hint: 'X', icon: 'modifyExtend' },
  { tool: 'explode', label: 'Explode', hint: 'E', icon: 'modifyExplode' },
];

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

function valueLabel(tool: ModifyToolKind): string {
  return tool === 'fillet' ? 'Radius' : 'Distance';
}

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

  const hint = phaseHint(activeTool, phase);

  return (
    <>
      <div
        className="vp-tool-palette vp-tool-palette--modify"
        role="toolbar"
        aria-label="2D modify tools"
      >
        {TOOL_BUTTONS.map(({ tool, label, hint: kbHint, icon }) => (
          <button
            key={tool}
            type="button"
            className={`draw-tool-btn${activeTool === tool ? ' draw-tool-btn--active' : ''}`}
            onClick={() => onSelectTool(activeTool === tool ? 'none' : tool)}
            aria-pressed={activeTool === tool}
            title={`${label} (${kbHint})`}
            aria-label={label}
          >
            <Icon name={icon} size={16} />
          </button>
        ))}

        {phase === 'enter-value' && (
          <div className="vp-popover modify-tool-input-row">
            <label className="vp-field-label" htmlFor="modify-value-input">
              {valueLabel(activeTool)}
            </label>
            <input
              id="modify-value-input"
              ref={inputRef}
              className="modify-tool-input"
              type="number"
              min={0.001}
              step={0.1}
              // Uncontrolled: a controlled number input rewrites "0." to "0" mid-typing, so a
              // decimal such as 0.5 could never be entered. The input only exists in this phase,
              // so `defaultValue` is always the freshly reset pending value.
              key={activeTool}
              defaultValue={pendingValue}
              onChange={(e) => {
                const value = parseFloat(e.target.value);
                if (!isNaN(value)) onSetValue(value);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  onCommitValue();
                }
              }}
              aria-label={`${valueLabel(activeTool)} value`}
            />
            <button
              type="button"
              className="vp-primary-btn"
              onClick={onCommitValue}
              aria-label="Apply"
            >
              Apply
            </button>
          </div>
        )}
      </div>

      {hint && (
        <div className="vp-hint" role="status" aria-live="polite">
          {hint}
        </div>
      )}
    </>
  );
}
