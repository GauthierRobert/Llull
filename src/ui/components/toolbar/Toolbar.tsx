/**
 * @layer ui/components/toolbar
 *
 * Main toolbar — the one place a user creates and edits things: labeled groups for selection,
 * 2D drawing, 3D solids, transforms and edit actions. Drawing arms a 2D tool (switching to the
 * 2D view); a solid button creates the primitive in view, selects it and shows the move gizmo.
 * Param-gathering + dispatch only (react R1).
 */

import React from 'react';
import { useStore, useToolStore } from '@ui/store';
import type { DrawToolKind, GizmoMode } from '@ui/store';
import { Icon } from '@ui/components/Icon';
import type { IconName } from '@ui/components/Icon';
import { deleteSelection, duplicateSelection } from '@ui/hooks/selectionActions';
import { DRAW_TOOL_KEYS, GIZMO_KEYS } from '@ui/hooks/shortcuts';
import { SOLID_PRESETS } from './solidPresets';
import { createSolid } from './createSolid';

// ---------------------------------------------------------------------------
// Button primitive
// ---------------------------------------------------------------------------

interface ToolButtonProps {
  label: string;
  icon: IconName;
  /** Tooltip body; the shortcut key is appended when given. */
  tip: string;
  shortcut?: string | undefined;
  pressed?: boolean | undefined;
  disabled?: boolean;
  onClick: () => void;
}

function ToolButton({
  label,
  icon,
  tip,
  shortcut,
  pressed,
  disabled = false,
  onClick,
}: ToolButtonProps): React.ReactElement {
  const title = shortcut === undefined ? `${label} — ${tip}` : `${label} (${shortcut}) — ${tip}`;
  return (
    <button
      type="button"
      className={`tb-btn${pressed === true ? ' tb-btn--active' : ''}`}
      aria-label={label}
      aria-pressed={pressed}
      title={title}
      disabled={disabled}
      onClick={onClick}
    >
      <Icon name={icon} size={18} />
      <span className="tb-btn__label">{label}</span>
    </button>
  );
}

function ToolGroup({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="tb-group" role="group" aria-label={title}>
      <div className="tb-group__buttons">{children}</div>
      <span className="tb-group__title" aria-hidden="true">
        {title}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------

interface DrawToolSpec {
  tool: DrawToolKind;
  label: string;
  icon: IconName;
  tip: string;
}

const DRAW_TOOLS: readonly DrawToolSpec[] = [
  { tool: 'line', label: 'Line', icon: 'drawLine', tip: 'click start, then end point' },
  {
    tool: 'polyline',
    label: 'Polyline',
    icon: 'drawPolyline',
    tip: 'click points, Enter or double-click to finish',
  },
  {
    tool: 'rectangle',
    label: 'Rectangle',
    icon: 'drawRectangle',
    tip: 'click two opposite corners',
  },
  { tool: 'circle', label: 'Circle', icon: 'drawCircle', tip: 'click center, then a rim point' },
  {
    tool: 'ellipse',
    label: 'Ellipse',
    icon: 'drawEllipse',
    tip: 'click center, then a bounding-box corner',
  },
  {
    tool: 'spline',
    label: 'Spline',
    icon: 'drawSpline',
    tip: 'click through-points, Enter to finish',
  },
  { tool: 'point', label: 'Point', icon: 'drawPoint', tip: 'click to place a point' },
  {
    tool: 'wall',
    label: 'Wall',
    icon: 'wall',
    tip: 'click wall centerline points, Enter to finish',
  },
];

function DrawGroup(): React.ReactElement {
  const drawTool = useToolStore((s) => s.drawTool);
  const viewMode = useToolStore((s) => s.viewMode);
  const setDrawTool = useToolStore((s) => s.setDrawTool);
  return (
    <ToolGroup title="Draw 2D">
      {DRAW_TOOLS.map((spec) => {
        const active = viewMode === '2d' && drawTool === spec.tool;
        return (
          <ToolButton
            key={spec.tool}
            label={spec.label}
            icon={spec.icon}
            tip={spec.tip}
            shortcut={DRAW_TOOL_KEYS[spec.tool]}
            pressed={active}
            onClick={() => setDrawTool(active ? 'none' : spec.tool)}
          />
        );
      })}
    </ToolGroup>
  );
}

function SolidsGroup(): React.ReactElement {
  return (
    <ToolGroup title="Solids 3D">
      {SOLID_PRESETS.map((preset) => (
        <ToolButton
          key={preset.command}
          label={preset.label}
          icon={preset.icon}
          tip="adds one at a free spot near the origin and selects it so you can drag it"
          onClick={() => createSolid(preset)}
        />
      ))}
    </ToolGroup>
  );
}

const GIZMO_BUTTONS: ReadonlyArray<{ mode: GizmoMode; label: string; icon: IconName }> = [
  { mode: 'translate', label: 'Move', icon: 'transformMove' },
  { mode: 'rotate', label: 'Rotate', icon: 'transformRotate' },
  { mode: 'scale', label: 'Scale', icon: 'transformScale' },
];

function SelectTransformGroup(): React.ReactElement {
  const viewMode = useToolStore((s) => s.viewMode);
  const drawTool = useToolStore((s) => s.drawTool);
  const gizmoMode = useToolStore((s) => s.gizmoMode);
  const setDrawTool = useToolStore((s) => s.setDrawTool);
  const setGizmoMode = useToolStore((s) => s.setGizmoMode);
  const selectionCount = useStore((s) => s.document.selection.length);
  const nothingSelected = selectionCount === 0;
  const is2d = viewMode === '2d';

  return (
    <ToolGroup title="Select & transform">
      <ToolButton
        label="Select"
        icon="cursor"
        tip="click an object to select it, Shift-click to add more"
        shortcut={is2d ? DRAW_TOOL_KEYS.none : undefined}
        pressed={is2d ? drawTool === 'none' : undefined}
        onClick={() => setDrawTool('none')}
      />
      {GIZMO_BUTTONS.map(({ mode, label, icon }) => {
        if (is2d) {
          const isMove = mode === 'translate';
          return (
            <ToolButton
              key={mode}
              label={label}
              icon={icon}
              tip={
                isMove
                  ? nothingSelected
                    ? 'select something first'
                    : 'click a base point, then where it should go'
                  : 'switch to the 3D view to rotate or scale'
              }
              shortcut={isMove ? DRAW_TOOL_KEYS.move : undefined}
              pressed={isMove && drawTool === 'move'}
              disabled={!isMove || nothingSelected}
              onClick={() => setDrawTool(drawTool === 'move' ? 'none' : 'move')}
            />
          );
        }
        return (
          <ToolButton
            key={mode}
            label={label}
            icon={icon}
            tip={
              selectionCount === 1
                ? 'drag the gizmo handles on the selected object'
                : 'select one object, then drag the gizmo handles'
            }
            shortcut={GIZMO_KEYS[mode]}
            pressed={gizmoMode === mode}
            onClick={() => setGizmoMode(mode)}
          />
        );
      })}
    </ToolGroup>
  );
}

function EditGroup(): React.ReactElement {
  const nothingSelected = useStore((s) => s.document.selection.length === 0);
  const canUndo = useStore((s) => s.canUndo);
  const canRedo = useStore((s) => s.canRedo);
  const undo = useStore((s) => s.undo);
  const redo = useStore((s) => s.redo);
  return (
    <ToolGroup title="Edit">
      <ToolButton
        label="Duplicate"
        icon="copy"
        tip={nothingSelected ? 'select something first' : 'copy the selection beside itself'}
        shortcut="Ctrl D"
        disabled={nothingSelected}
        onClick={duplicateSelection}
      />
      <ToolButton
        label="Delete"
        icon="trash"
        tip={nothingSelected ? 'select something first' : 'delete the selection'}
        shortcut="Del"
        disabled={nothingSelected}
        onClick={deleteSelection}
      />
      <ToolButton
        label="Undo"
        icon="undo"
        tip="step back"
        shortcut="Ctrl Z"
        disabled={!canUndo}
        onClick={undo}
      />
      <ToolButton
        label="Redo"
        icon="redo"
        tip="step forward"
        shortcut="Ctrl Y"
        disabled={!canRedo}
        onClick={redo}
      />
    </ToolGroup>
  );
}

// ---------------------------------------------------------------------------
// Toolbar
// ---------------------------------------------------------------------------

export function Toolbar(): React.ReactElement {
  const setShortcutsOpen = useToolStore((s) => s.setShortcutsOpen);
  return (
    <div className="toolbar" role="toolbar" aria-label="Main toolbar">
      <SelectTransformGroup />
      <span className="tb-sep" aria-hidden="true" />
      <SolidsGroup />
      <span className="tb-sep" aria-hidden="true" />
      <DrawGroup />
      <span className="tb-sep" aria-hidden="true" />
      <EditGroup />
      <div className="tb-spacer" />
      <ToolButton
        label="Shortcuts"
        icon="keyboard"
        tip="list every keyboard shortcut"
        shortcut="?"
        onClick={() => setShortcutsOpen(true)}
      />
    </div>
  );
}
