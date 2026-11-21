// Selection bar (above the command bar, only while something is selected): what can be done with THIS selection, by name.
// Transform (Move / Rotate / Scale), the features the selection offers (Extrude a sketch, Fillet / Shell / Edit faces a solid,
// Union / Subtract / Intersect several solids), then Duplicate, Hide, Delete and "More" (the palette, suggestions first).

import React from 'react';
import { is3D } from '@core/model/types';
import { classNames } from '@ui/classNames';
import { type GizmoMode, usePaletteStore, useStore, useToolStore } from '@ui/store';
import { type IconName, Icon } from '@ui/components/Icon';
import { deleteSelection, duplicateSelection, hideSelection } from '@ui/actions/selectionActions';
import { DRAW_TOOL_KEYS, GIZMO_KEYS, PALETTE_SHORTCUT_LABEL } from '@ui/hooks/shortcuts';
import { FeatureStartBar } from '@ui/viewport/3d/manipulators/FeatureStartBar';
import { FaceEditStart } from '@ui/viewport/3d/faceEdit/FaceEditBar';
import { combineTools, openCommandTool } from './commandTools';

interface BarButtonProps {
  label: string;
  icon: IconName;
  tip: string;
  shortcut?: string | undefined;
  pressed?: boolean | undefined;
  disabled?: boolean;
  /** Icon only (the label stays the accessible name and tooltip). */
  compact?: boolean;
  /** Visible caption when it differs from the accessible name. */
  caption?: string;
  tone?: 'danger';
  onClick: () => void;
}

function BarButton({
  label,
  icon,
  tip,
  shortcut,
  pressed,
  disabled = false,
  compact = false,
  caption,
  tone,
  onClick,
}: BarButtonProps): React.ReactElement {
  const title = shortcut === undefined ? `${label} — ${tip}` : `${label} (${shortcut}) — ${tip}`;
  return (
    <button
      type="button"
      className={classNames(
        'selbar-btn',
        compact && 'selbar-btn--compact',
        pressed === true && 'selbar-btn--active',
        tone === 'danger' && 'selbar-btn--danger',
      )}
      aria-label={label}
      aria-pressed={pressed}
      title={title}
      disabled={disabled}
      onClick={onClick}
    >
      <Icon name={icon} size={15} />
      {!compact && <span>{caption ?? label}</span>}
    </button>
  );
}

function Divider(): React.ReactElement {
  return <span className="selbar-divider" aria-hidden="true" />;
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
  return (
    <div className="selbar-group" role="group" aria-label="Transform">
      {GIZMO_BUTTONS.map(({ mode, label, icon }) => {
        if (viewMode === '2d') {
          const isMove = mode === 'translate';
          return (
            <BarButton
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
          <BarButton
            key={mode}
            label={label}
            icon={icon}
            tip={selectionCount === 1 ? 'drag the handles on the selected object' : 'select one object, then drag its handles'}
            shortcut={GIZMO_KEYS[mode]}
            pressed={gizmoMode === mode}
            onClick={() => setGizmoMode(mode)}
          />
        );
      })}
    </div>
  );
}

/** How many of the selected entities are 3D solids. */
function useSelectedSolidCount(): number {
  return useStore(
    (s) =>
      s.document.selection.filter((id) => {
        const entity = s.document.entities[id];
        return entity !== undefined && is3D(entity);
      }).length,
  );
}

/** Union / Subtract / Intersect while several solids are selected. */
function CombineButtons(): React.ReactElement | null {
  const solids = useSelectedSolidCount();
  const tools = combineTools();
  if (solids < 2 || tools.length === 0) return null;
  return (
    <div className="selbar-group" role="group" aria-label="Combine">
      {tools.map((tool) => (
        <BarButton key={tool.id} label={tool.label} icon={tool.icon} tip={tool.hint} onClick={() => openCommandTool(tool)} />
      ))}
    </div>
  );
}

function selectionLabel(count: number, soleName: string | undefined): string {
  return count === 1 ? (soleName ?? '1 selected') : `${count} selected`;
}

export function SelectionBar(): React.ReactElement {
  const count = useStore((s) => s.document.selection.length);
  const soleName = useStore((s) => {
    const [id] = s.document.selection;
    const entity = s.document.selection.length === 1 && id !== undefined ? s.document.entities[id] : undefined;
    return entity === undefined ? undefined : (entity.name ?? entity.kind);
  });
  const clearSelection = useStore((s) => s.clearSelection);
  return (
    <div className="selbar" role="toolbar" aria-label="Selection actions">
      <button
        type="button"
        className="selbar-count"
        title="Clear the selection (Esc)"
        aria-label="Clear selection"
        onClick={clearSelection}
      >
        <span className="selbar-count__text">{selectionLabel(count, soleName)}</span>
        <Icon name="close" size={11} />
      </button>
      <Divider />
      <TransformButtons />
      <div className="selbar-features">
        <FeatureStartBar />
        <FaceEditStart />
        <CombineButtons />
      </div>
      <Divider />
      <BarButton
        compact
        label="Duplicate"
        icon="copy"
        tip="copy the selection beside itself"
        shortcut="Ctrl D"
        onClick={duplicateSelection}
      />
      <BarButton
        compact
        label="Hide"
        icon="eyeOff"
        tip="hide the selection (Alt H shows everything again)"
        shortcut="H"
        onClick={hideSelection}
      />
      <BarButton compact tone="danger" label="Delete" icon="trash" tip="delete the selection" shortcut="Del" onClick={deleteSelection} />
      <Divider />
      <BarButton
        label="More actions"
        caption="More"
        icon="more"
        tip="every command that fits this selection"
        shortcut={PALETTE_SHORTCUT_LABEL}
        onClick={() => usePaletteStore.getState().setOpen(true)}
      />
    </div>
  );
}
