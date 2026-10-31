// Command bar (bottom-center). Idle it is one line: a Tools button and "Search or run a command" (opens the palette).
// Everything else is on demand: the Tools panel (sketch tools, solids, view mode, select, shortcuts), the armed
// tool chip, an Undo/Redo pair (disabled when idle), and the selection's actions while something is selected.

import React, { useCallback, useRef, useState } from 'react';
import { classNames } from '@ui/classNames';
import { type GizmoMode, usePaletteStore, useStore, useToolStore } from '@ui/store';
import { type IconName, Icon } from '@ui/components/Icon';
import { deleteSelection, duplicateSelection } from '@ui/actions/selectionActions';
import { DRAW_TOOL_KEYS, GIZMO_KEYS, PALETTE_SHORTCUT_LABEL } from '@ui/hooks/shortcuts';
import { useDismiss } from '@ui/hooks/useDismiss';
import { createSolid } from '@ui/actions/createSolid';
import { SOLID_PRESETS } from './solidPresets';
import { DRAW_TOOLS } from './drawTools';
import { type DockTrayItem, DockTray } from './DockTray';

interface DockButtonProps {
  label: string;
  icon: IconName;
  /** The shortcut key is appended when given. */
  tip: string;
  shortcut?: string | undefined;
  pressed?: boolean | undefined;
  disabled?: boolean;
  /** With a visible caption (default: icon only, the label is the accessible name and tooltip). */
  caption?: boolean;
  tone?: 'danger';
  onClick: () => void;
}

function DockButton({
  label,
  icon,
  tip,
  shortcut,
  pressed,
  disabled = false,
  caption = false,
  tone,
  onClick,
}: DockButtonProps): React.ReactElement {
  const title = shortcut === undefined ? `${label} — ${tip}` : `${label} (${shortcut}) — ${tip}`;
  return (
    <button
      type="button"
      className={classNames(
        'dock-btn',
        !caption && 'dock-btn--compact',
        pressed === true && 'dock-btn--active',
        tone === 'danger' && 'dock-btn--danger',
      )}
      aria-label={label}
      aria-pressed={pressed}
      title={title}
      disabled={disabled}
      onClick={onClick}
    >
      <Icon name={icon} size={16} />
      {caption && <span className="dock-btn__label">{label}</span>}
    </button>
  );
}

function DockDivider(): React.ReactElement {
  return <span className="dock-divider" aria-hidden="true" />;
}

function ViewModeSwitch(): React.ReactElement {
  const viewMode = useToolStore((s) => s.viewMode);
  const setViewMode = useToolStore((s) => s.setViewMode);
  return (
    <div className="dock-view" role="group" aria-label="View mode">
      <button
        type="button"
        className="dock-view__btn"
        aria-pressed={viewMode === '3d'}
        title="3D view (3)"
        onClick={() => setViewMode('3d')}
      >
        3D
      </button>
      <button
        type="button"
        className="dock-view__btn"
        aria-pressed={viewMode === '2d'}
        title="2D drafting view (2)"
        onClick={() => setViewMode('2d')}
      >
        2D
      </button>
    </div>
  );
}

/** The 2D draw tool currently armed, if any. */
function useArmedSketchTool(): (typeof DRAW_TOOLS)[number] | undefined {
  const drawTool = useToolStore((s) => s.drawTool);
  const viewMode = useToolStore((s) => s.viewMode);
  return viewMode === '2d' ? DRAW_TOOLS.find((spec) => spec.tool === drawTool) : undefined;
}

function useSketchItems(close: () => void): DockTrayItem[] {
  const setDrawTool = useToolStore((s) => s.setDrawTool);
  const armed = useArmedSketchTool();
  return DRAW_TOOLS.map((spec) => {
    const active = spec === armed;
    return {
      id: spec.tool,
      label: spec.label,
      icon: spec.icon,
      hint: spec.tip,
      shortcut: DRAW_TOOL_KEYS[spec.tool],
      active,
      onPick: () => {
        setDrawTool(active ? 'none' : spec.tool);
        close();
      },
    };
  });
}

function solidItems(close: () => void): DockTrayItem[] {
  return SOLID_PRESETS.map((preset) => ({
    id: preset.command,
    label: preset.label,
    icon: preset.icon,
    hint: 'adds one at a free spot near the origin and selects it so you can drag it',
    onPick: () => {
      createSolid(preset);
      close();
    },
  }));
}

function ToolsPanel({ close }: { close: () => void }): React.ReactElement {
  const drawTool = useToolStore((s) => s.drawTool);
  const viewMode = useToolStore((s) => s.viewMode);
  const setDrawTool = useToolStore((s) => s.setDrawTool);
  const setShortcutsOpen = useToolStore((s) => s.setShortcutsOpen);
  const sketchItems = useSketchItems(close);
  const is2d = viewMode === '2d';
  return (
    <div className="dock-panel" id="dock-tools" role="group" aria-label="Tools">
      <DockTray id="dock-tray-sketch" label="Sketch tools" items={sketchItems} />
      <DockTray id="dock-tray-solid" label="Solid tools" items={solidItems(close)} />
      <div className="dock-panel__footer">
        <ViewModeSwitch />
        <DockButton
          caption
          label="Select"
          icon="cursor"
          tip="click an object to select it, Shift-click to add more"
          shortcut={is2d ? DRAW_TOOL_KEYS.none : undefined}
          pressed={is2d ? drawTool === 'none' : undefined}
          onClick={() => {
            setDrawTool('none');
            close();
          }}
        />
        <span className="dock-panel__spacer" />
        <DockButton
          label="Shortcuts"
          icon="keyboard"
          tip="list every keyboard shortcut"
          shortcut="?"
          onClick={() => setShortcutsOpen(true)}
        />
      </div>
    </div>
  );
}

const GIZMO_BUTTONS: ReadonlyArray<{ mode: GizmoMode; label: string; icon: IconName }> = [
  { mode: 'translate', label: 'Move', icon: 'transformMove' },
  { mode: 'rotate', label: 'Rotate', icon: 'transformRotate' },
  { mode: 'scale', label: 'Scale', icon: 'transformScale' },
];

/** Move / Rotate / Scale, Duplicate, Delete — only while something is selected. */
function SelectionActions(): React.ReactElement {
  const viewMode = useToolStore((s) => s.viewMode);
  const drawTool = useToolStore((s) => s.drawTool);
  const gizmoMode = useToolStore((s) => s.gizmoMode);
  const toggleDrawTool = useToolStore((s) => s.toggleDrawTool);
  const setGizmoMode = useToolStore((s) => s.setGizmoMode);
  const selectionCount = useStore((s) => s.document.selection.length);
  return (
    <>
      <DockDivider />
      {GIZMO_BUTTONS.map(({ mode, label, icon }) => {
        if (viewMode === '2d') {
          const isMove = mode === 'translate';
          return (
            <DockButton
              key={mode}
              label={label}
              icon={icon}
              tip={isMove ? 'click a base point, then where it should go' : 'switch to the 3D view to rotate or scale'}
              shortcut={isMove ? DRAW_TOOL_KEYS.move : undefined}
              pressed={isMove && drawTool === 'move'}
              disabled={!isMove}
              onClick={() => toggleDrawTool('move')}
            />
          );
        }
        return (
          <DockButton
            key={mode}
            label={label}
            icon={icon}
            tip={selectionCount === 1 ? 'drag the gizmo handles on the selected object' : 'select one object, then drag the gizmo handles'}
            shortcut={GIZMO_KEYS[mode]}
            pressed={gizmoMode === mode}
            onClick={() => setGizmoMode(mode)}
          />
        );
      })}
      <DockButton label="Duplicate" icon="copy" tip="copy the selection beside itself" shortcut="Ctrl D" onClick={duplicateSelection} />
      <DockButton tone="danger" label="Delete" icon="trash" tip="delete the selection" shortcut="Del" onClick={deleteSelection} />
    </>
  );
}

/** The armed 2D tool as a chip; clicking it puts the tool down. */
function ArmedToolChip(): React.ReactElement | null {
  const armed = useArmedSketchTool();
  const setDrawTool = useToolStore((s) => s.setDrawTool);
  if (armed === undefined) return null;
  return (
    <button
      type="button"
      className="dock-chip"
      aria-label={`Stop the ${armed.label} tool`}
      title={`${armed.label} — ${armed.tip} (Esc to stop)`}
      onClick={() => setDrawTool('none')}
    >
      <Icon name={armed.icon} size={14} />
      {armed.label}
      <Icon name="close" size={12} className="dock-chip__close" />
    </button>
  );
}

function AskButton(): React.ReactElement {
  const setOpen = usePaletteStore((s) => s.setOpen);
  return (
    <button
      type="button"
      className="dock-ask"
      onClick={() => setOpen(true)}
      aria-label={`Search or run a command… ${PALETTE_SHORTCUT_LABEL}`}
      aria-keyshortcuts="Control+K Meta+K"
      title={`Search every action and command (${PALETTE_SHORTCUT_LABEL})`}
    >
      <Icon name="search" size={15} />
      <span className="dock-ask__text">Search or run a command…</span>
      <kbd className="dock-ask__kbd">{PALETTE_SHORTCUT_LABEL}</kbd>
    </button>
  );
}

/** Always present (disabled when there is nothing to step through) so the bar never shifts. */
function UndoRedo(): React.ReactElement {
  const canUndo = useStore((s) => s.canUndo);
  const canRedo = useStore((s) => s.canRedo);
  const undo = useStore((s) => s.undo);
  const redo = useStore((s) => s.redo);
  return (
    <>
      <DockButton label="Undo" icon="undo" tip="step back" shortcut="Ctrl Z" disabled={!canUndo} onClick={undo} />
      <DockButton label="Redo" icon="redo" tip="step forward" shortcut="Ctrl Y" disabled={!canRedo} onClick={redo} />
    </>
  );
}

export function Toolbar(): React.ReactElement {
  const [toolsOpen, setToolsOpen] = useState(false);
  const dockRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setToolsOpen(false), []);
  useDismiss(dockRef, toolsOpen, close);

  const hasSelection = useStore((s) => s.document.selection.length > 0);
  return (
    <div className="dock" ref={dockRef}>
      {toolsOpen && <ToolsPanel close={close} />}
      <div className="dock__bar" role="toolbar" aria-label="Main toolbar">
        <button
          type="button"
          className={classNames('dock-btn', 'dock-btn--compact', 'dock-tools-btn', toolsOpen && 'dock-btn--active')}
          aria-label="Tools"
          aria-expanded={toolsOpen}
          aria-controls={toolsOpen ? 'dock-tools' : undefined}
          title="Tools — sketch, solids, view mode"
          onClick={() => setToolsOpen((open) => !open)}
        >
          <Icon name="plus" size={18} />
        </button>
        <ArmedToolChip />
        <AskButton />
        <UndoRedo />
        {hasSelection && <SelectionActions />}
      </div>
    </div>
  );
}
