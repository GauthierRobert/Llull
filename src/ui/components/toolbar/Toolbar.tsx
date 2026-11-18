// Command bar (bottom-center). Every tool family is visible by name: Select, then Sketch / Solid / Modify / Inspect, each opening a
// flyout of labelled tools; then "Search or run a command" (the palette, for everything else) and Undo / Redo. While something is
// selected, the selection bar above it offers what can be done with that selection.

import React, { useCallback, useRef, useState } from 'react';
import { classNames } from '@ui/classNames';
import { usePaletteStore, useStore, useToolStore } from '@ui/store';
import { type IconName, Icon } from '@ui/components/Icon';
import { HintBar } from '@ui/components/HintBar';
import { PALETTE_SHORTCUT_LABEL } from '@ui/hooks/shortcuts';
import { useDismiss } from '@ui/hooks/useDismiss';
import { DRAW_TOOLS } from './drawTools';
import { type DockTrayItem, DockTray } from './DockTray';
import { SelectionBar } from './SelectionBar';
import { type ToolGroupId, TOOL_GROUPS, flyoutSections } from './toolFlyouts';

interface DockButtonProps {
  label: string;
  icon: IconName;
  /** The shortcut key is appended when given. */
  tip: string;
  shortcut?: string;
  disabled?: boolean;
  onClick: () => void;
}

function DockButton({ label, icon, tip, shortcut, disabled = false, onClick }: DockButtonProps): React.ReactElement {
  const title = shortcut === undefined ? `${label} — ${tip}` : `${label} (${shortcut}) — ${tip}`;
  return (
    <button type="button" className="dock-btn dock-btn--compact" aria-label={label} title={title} disabled={disabled} onClick={onClick}>
      <Icon name={icon} size={16} />
    </button>
  );
}

function DockDivider(): React.ReactElement {
  return <span className="dock-divider" aria-hidden="true" />;
}

/** The 2D draw tool currently armed, if any. */
function useArmedSketchTool(): (typeof DRAW_TOOLS)[number] | undefined {
  const drawTool = useToolStore((s) => s.drawTool);
  const viewMode = useToolStore((s) => s.viewMode);
  return viewMode === '2d' ? DRAW_TOOLS.find((spec) => spec.tool === drawTool) : undefined;
}

/** The default tool: pressed while nothing else is in hand; clicking it puts any armed tool down. */
function SelectButton({ onPick }: { onPick: () => void }): React.ReactElement {
  const idle = useToolStore((s) => s.drawTool === 'none' && s.modifyTool === 'none');
  return (
    <button
      type="button"
      className={classNames('dock-btn', idle && 'dock-btn--active')}
      aria-label="Select"
      aria-pressed={idle}
      title="Select (V) — click an object to select it, Shift-click to add more"
      onClick={() => {
        const tools = useToolStore.getState();
        tools.setDrawTool('none');
        tools.setModifyTool('none');
        onPick();
      }}
    >
      <Icon name="cursor" size={16} />
      <span className="dock-btn__label">Select</span>
    </button>
  );
}

interface GroupButtonProps {
  group: (typeof TOOL_GROUPS)[number];
  open: boolean;
  /** Another flyout is open: hovering this button switches to its flyout (menu-bar behaviour). */
  switchOnHover: boolean;
  onToggle: (id: ToolGroupId) => void;
  onOpen: (id: ToolGroupId) => void;
}

function GroupButton({ group, open, switchOnHover, onToggle, onOpen }: GroupButtonProps): React.ReactElement {
  const armed = useArmedSketchTool();
  // The Sketch button carries the armed tool, so the tool in hand is always visible in the bar.
  const carried = group.id === 'sketch' ? armed : undefined;
  return (
    <button
      type="button"
      className={classNames('dock-btn', 'dock-group-btn', (open || carried !== undefined) && 'dock-btn--active')}
      aria-label={group.label}
      aria-haspopup="true"
      aria-expanded={open}
      aria-controls={open ? 'dock-flyout' : undefined}
      title={carried === undefined ? `${group.label} — ${group.tip}` : `${carried.label} tool in hand — ${carried.tip} (Esc to stop)`}
      onClick={() => onToggle(group.id)}
      onPointerEnter={() => {
        if (switchOnHover) onOpen(group.id);
      }}
    >
      <Icon name={carried?.icon ?? group.icon} size={16} />
      <span className="dock-btn__label">{carried?.label ?? group.label}</span>
      <Icon name="chevronDown" size={12} className="dock-group-btn__caret" />
    </button>
  );
}

const FLYOUT_PROMPT = 'Point at a tool to see what it does.';

function Flyout({ group, close }: { group: ToolGroupId; close: () => void }): React.ReactElement {
  // Subscribed so an armed tool or a view switch re-renders the sections (they read the store at call time).
  useToolStore((s) => `${s.viewMode}:${s.drawTool}:${s.modifyTool}`);
  const [described, setDescribed] = useState<DockTrayItem | null>(null);
  const spec = TOOL_GROUPS.find((candidate) => candidate.id === group);
  const sections = flyoutSections(group, close);
  return (
    <div className="dock-panel" id="dock-flyout" role="group" aria-label={`${spec?.label ?? group} tools`}>
      {sections.map((section) => (
        <DockTray key={section.id} label={section.label} items={section.items} onDescribe={setDescribed} />
      ))}
      <p className="dock-panel__hint" role="status">
        {described === null ? (
          FLYOUT_PROMPT
        ) : (
          <>
            <b>{described.label}</b> — {described.hint}
          </>
        )}
      </p>
    </div>
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
      <span className="dock-ask__text">Search commands…</span>
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
  const [openGroup, setOpenGroup] = useState<ToolGroupId | null>(null);
  const dockRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpenGroup(null), []);
  useDismiss(dockRef, openGroup !== null, close);
  const toggle = useCallback((id: ToolGroupId) => setOpenGroup((current) => (current === id ? null : id)), []);

  const hasSelection = useStore((s) => s.document.selection.length > 0);
  return (
    <div className="dock" ref={dockRef}>
      {openGroup === null && <HintBar />}
      {openGroup !== null && <Flyout key={openGroup} group={openGroup} close={close} />}
      {openGroup === null && hasSelection && <SelectionBar />}
      <div className="dock__bar" role="toolbar" aria-label="Main toolbar">
        <SelectButton onPick={close} />
        <DockDivider />
        {TOOL_GROUPS.map((group) => (
          <GroupButton
            key={group.id}
            group={group}
            open={openGroup === group.id}
            switchOnHover={openGroup !== null && openGroup !== group.id}
            onToggle={toggle}
            onOpen={setOpenGroup}
          />
        ))}
        <DockDivider />
        <AskButton />
        <DockDivider />
        <UndoRedo />
      </div>
    </div>
  );
}
