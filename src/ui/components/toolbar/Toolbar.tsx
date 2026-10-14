// Tool dock (bottom-center): 3D/2D switch, Select, Sketch and Solid trays, transforms, selection edits, undo/redo,
// shortcuts. Sketch arms a 2D tool (switching to 2D); Solid adds a primitive, selected, with the move gizmo.

import React, { useEffect, useRef, useState } from 'react';
import { classNames } from '@ui/classNames';
import { type GizmoMode, useStore, useToolStore } from '@ui/store';
import { type IconName, Icon } from '@ui/components/Icon';
import { deleteSelection, duplicateSelection } from '@ui/actions/selectionActions';
import { DRAW_TOOL_KEYS, GIZMO_KEYS } from '@ui/hooks/shortcuts';
import { createSolid } from '@ui/actions/createSolid';
import { SOLID_PRESETS } from './solidPresets';
import { DRAW_TOOLS } from './drawTools';
import { type DockTrayItem, DockTray } from './DockTray';

type TrayId = 'sketch' | 'solid';

interface DockButtonProps {
  label: string;
  icon: IconName;
  /** The shortcut key is appended when given. */
  tip: string;
  shortcut?: string | undefined;
  pressed?: boolean | undefined;
  disabled?: boolean;
  /** Icon-only: the label is the accessible name and tooltip only. */
  compact?: boolean;
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
  compact = false,
  tone,
  onClick,
}: DockButtonProps): React.ReactElement {
  const title = shortcut === undefined ? `${label} — ${tip}` : `${label} (${shortcut}) — ${tip}`;
  return (
    <button
      type="button"
      className={classNames(
        'dock-btn',
        compact && 'dock-btn--compact',
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
      {!compact && <span className="dock-btn__label">{label}</span>}
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

interface TrayTriggerProps {
  tray: TrayId;
  label: string;
  caption: string;
  icon: IconName;
  open: boolean;
  armed: boolean;
  onToggle: (tray: TrayId) => void;
}

function TrayTrigger({ tray, label, caption, icon, open, armed, onToggle }: TrayTriggerProps): React.ReactElement {
  return (
    <button
      type="button"
      className={classNames('dock-btn', (open || armed) && 'dock-btn--active')}
      aria-label={label}
      aria-expanded={open}
      aria-controls={open ? `dock-tray-${tray}` : undefined}
      title={label}
      onClick={() => onToggle(tray)}
    >
      <Icon name={icon} size={16} />
      <span className="dock-btn__label">{caption}</span>
      <Icon name="chevronDown" size={12} className="dock-btn__caret" />
    </button>
  );
}

function useSketchItems(close: () => void): { items: DockTrayItem[]; armed: { label: string; icon: IconName } | null } {
  const drawTool = useToolStore((s) => s.drawTool);
  const viewMode = useToolStore((s) => s.viewMode);
  const setDrawTool = useToolStore((s) => s.setDrawTool);
  const armed = viewMode === '2d' ? DRAW_TOOLS.find((spec) => spec.tool === drawTool) : undefined;
  const items = DRAW_TOOLS.map((spec) => {
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
  return { items, armed: armed === undefined ? null : { label: armed.label, icon: armed.icon } };
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

const GIZMO_BUTTONS: ReadonlyArray<{ mode: GizmoMode; label: string; icon: IconName }> = [
  { mode: 'translate', label: 'Move', icon: 'transformMove' },
  { mode: 'rotate', label: 'Rotate', icon: 'transformRotate' },
  { mode: 'scale', label: 'Scale', icon: 'transformScale' },
];

function TransformButtons(): React.ReactElement {
  const viewMode = useToolStore((s) => s.viewMode);
  const drawTool = useToolStore((s) => s.drawTool);
  const gizmoMode = useToolStore((s) => s.gizmoMode);
  const toggleDrawTool = useToolStore((s) => s.toggleDrawTool);
  const setGizmoMode = useToolStore((s) => s.setGizmoMode);
  const selectionCount = useStore((s) => s.document.selection.length);
  const nothingSelected = selectionCount === 0;
  return (
    <>
      {GIZMO_BUTTONS.map(({ mode, label, icon }) => {
        if (viewMode === '2d') {
          const isMove = mode === 'translate';
          return (
            <DockButton
              key={mode}
              compact
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
              disabled={!isMove || (nothingSelected && drawTool !== 'move')}
              onClick={() => toggleDrawTool('move')}
            />
          );
        }
        return (
          <DockButton
            key={mode}
            compact
            label={label}
            icon={icon}
            tip={selectionCount === 1 ? 'drag the gizmo handles on the selected object' : 'select one object, then drag the gizmo handles'}
            shortcut={GIZMO_KEYS[mode]}
            pressed={gizmoMode === mode}
            onClick={() => setGizmoMode(mode)}
          />
        );
      })}
    </>
  );
}

function EditButtons(): React.ReactElement {
  const nothingSelected = useStore((s) => s.document.selection.length === 0);
  return (
    <>
      <DockButton
        compact
        label="Duplicate"
        icon="copy"
        tip={nothingSelected ? 'select something first' : 'copy the selection beside itself'}
        shortcut="Ctrl D"
        disabled={nothingSelected}
        onClick={duplicateSelection}
      />
      <DockButton
        compact
        tone="danger"
        label="Delete"
        icon="trash"
        tip={nothingSelected ? 'select something first' : 'delete the selection'}
        shortcut="Del"
        disabled={nothingSelected}
        onClick={deleteSelection}
      />
    </>
  );
}

function HistoryButtons(): React.ReactElement {
  const canUndo = useStore((s) => s.canUndo);
  const canRedo = useStore((s) => s.canRedo);
  const undo = useStore((s) => s.undo);
  const redo = useStore((s) => s.redo);
  const setShortcutsOpen = useToolStore((s) => s.setShortcutsOpen);
  return (
    <>
      <DockButton compact label="Undo" icon="undo" tip="step back" shortcut="Ctrl Z" disabled={!canUndo} onClick={undo} />
      <DockButton compact label="Redo" icon="redo" tip="step forward" shortcut="Ctrl Y" disabled={!canRedo} onClick={redo} />
      <DockButton
        compact
        label="Shortcuts"
        icon="keyboard"
        tip="list every keyboard shortcut"
        shortcut="?"
        onClick={() => setShortcutsOpen(true)}
      />
    </>
  );
}

/** Closes the open tray on Escape or a pointer-down outside the dock. */
function useDismissTray(dockRef: React.RefObject<HTMLDivElement | null>, open: boolean, close: () => void): void {
  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (e: PointerEvent): void => {
      if (!(e.target instanceof Node) || dockRef.current?.contains(e.target) !== true) close();
    };
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [dockRef, open, close]);
}

export function Toolbar(): React.ReactElement {
  const [openTray, setOpenTray] = useState<TrayId | null>(null);
  const dockRef = useRef<HTMLDivElement>(null);
  const close = React.useCallback(() => setOpenTray(null), []);
  const toggleTray = (tray: TrayId): void => setOpenTray((current) => (current === tray ? null : tray));
  useDismissTray(dockRef, openTray !== null, close);

  const viewMode = useToolStore((s) => s.viewMode);
  const drawTool = useToolStore((s) => s.drawTool);
  const setDrawTool = useToolStore((s) => s.setDrawTool);
  const sketch = useSketchItems(close);
  const is2d = viewMode === '2d';

  return (
    <div className="dock" ref={dockRef}>
      {openTray === 'sketch' && <DockTray id="dock-tray-sketch" label="Sketch tools" items={sketch.items} />}
      {openTray === 'solid' && <DockTray id="dock-tray-solid" label="Solid tools" items={solidItems(close)} />}
      <div className="dock__bar" role="toolbar" aria-label="Main toolbar">
        <ViewModeSwitch />
        <DockButton
          label="Select"
          icon="cursor"
          tip="click an object to select it, Shift-click to add more"
          shortcut={is2d ? DRAW_TOOL_KEYS.none : undefined}
          pressed={is2d ? drawTool === 'none' : undefined}
          onClick={() => setDrawTool('none')}
        />
        <TrayTrigger
          tray="sketch"
          label="Sketch tools"
          caption={sketch.armed?.label ?? 'Sketch'}
          icon={sketch.armed?.icon ?? 'drawPolyline'}
          open={openTray === 'sketch'}
          armed={sketch.armed !== null}
          onToggle={toggleTray}
        />
        <TrayTrigger
          tray="solid"
          label="Solid tools"
          caption="Solid"
          icon="cube"
          open={openTray === 'solid'}
          armed={false}
          onToggle={toggleTray}
        />
        <DockDivider />
        <TransformButtons />
        <EditButtons />
        <DockDivider />
        <HistoryButtons />
      </div>
    </div>
  );
}
