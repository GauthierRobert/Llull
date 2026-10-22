// HTML chrome of cage editing: the "Edit cage" chip for a selected subdivision solid, and while editing a bar with the element mode,
// tools, soft-selection falloff, a live status line and "Copy as CLI" for the last committed gesture. Gathers params only.

import { useCallback } from 'react';
import { FALLOFF_SHAPES, type FalloffShape } from '@lib/falloff';
import { Icon } from '@ui/components/Icon';
import { useCaptureKeydown } from '@ui/hooks/useCaptureKeydown';
import { isEditingKeyEvent } from '@ui/hooks/useKeyboardShortcuts';
import { useStore } from '@ui/store';
import { useDirectEditStore } from '@ui/store/directEditStore';
import { useSoleSelectedEntity } from '@ui/store/selectionHooks';
import { hintFor, selectionText, sharpnessText } from './cageBarModel';
import type { CageElementKind } from './cageSelection';
import { type FalloffMetric, cliLine } from './gestureCommands';

const MODES: ReadonlyArray<{ kind: CageElementKind; label: string; key: string }> = [
  { kind: 'vertex', label: 'Vertex', key: '1' },
  { kind: 'edge', label: 'Edge', key: '2' },
  { kind: 'face', label: 'Face', key: '3' },
];

/** Tab on a selected subdivision solid starts cage editing (while editing, the cage keys own Tab). */
function useEnterCageKey(entityId: string | undefined): void {
  const editing = useDirectEditStore((s) => s.entityId !== null);
  const onKey = useCallback(
    (event: KeyboardEvent): void => {
      if (entityId === undefined || event.key !== 'Tab' || event.ctrlKey || event.metaKey || event.altKey || isEditingKeyEvent(event))
        return;
      event.preventDefault();
      useDirectEditStore.getState().enter(entityId);
    },
    [entityId],
  );
  useCaptureKeydown(editing ? null : onKey);
}

function CopyCliButton(): React.ReactElement {
  const lastCommit = useDirectEditStore((s) => s.lastCommit);
  const copy = (): void => {
    if (lastCommit === null) return;
    void navigator.clipboard.writeText(cliLine(lastCommit)).then(
      () => useStore.getState().setStatusMessage(`Copied the llull command for ${lastCommit.name}.`),
      () => useStore.getState().setStatusMessage('Could not copy to the clipboard.'),
    );
  };
  return (
    <button
      type="button"
      className="cage-bar__button"
      disabled={lastCommit === null}
      onClick={copy}
      title="Copy the last committed gesture as an llull command"
    >
      <Icon name="copy" size={12} /> Copy as CLI
    </button>
  );
}

function FalloffControls(): React.ReactElement {
  const falloff = useDirectEditStore((s) => s.falloff);
  const setFalloff = useDirectEditStore((s) => s.setFalloff);
  const off = !(falloff.radius > 0);
  return (
    <div className="cage-bar__group" role="group" aria-label="Soft selection">
      <label className="cage-bar__field">
        Falloff
        <input
          type="number"
          min={0}
          step={0.1}
          value={falloff.radius}
          onChange={(event) => setFalloff({ radius: Math.max(0, Number(event.target.value) || 0) })}
        />
      </label>
      <select
        aria-label="Falloff shape"
        value={falloff.shape}
        disabled={off}
        onChange={(event) => setFalloff({ shape: event.target.value as FalloffShape })}
      >
        {FALLOFF_SHAPES.map((shape) => (
          <option key={shape} value={shape}>
            {shape.replace('_', ' ')}
          </option>
        ))}
      </select>
      <select
        aria-label="Falloff metric"
        value={falloff.metric}
        disabled={off}
        onChange={(event) => setFalloff({ metric: event.target.value as FalloffMetric })}
      >
        <option value="euclidean">distance</option>
        <option value="topological">connected</option>
      </select>
    </div>
  );
}

export function CageEditBar(): React.ReactElement | null {
  const sole = useSoleSelectedEntity();
  const entityId = useDirectEditStore((s) => s.entityId);
  const elementMode = useDirectEditStore((s) => s.elementMode);
  const tool = useDirectEditStore((s) => s.tool);
  const selection = useDirectEditStore((s) => s.selection);
  const preview = useDirectEditStore((s) => s.preview);
  const cuts = useDirectEditStore((s) => s.cuts);
  const cage = useStore((s) => (entityId === null ? undefined : s.document.entities[entityId]));
  const enterable = sole?.kind === 'subdivision' ? sole.id : undefined;
  useEnterCageKey(enterable);

  if (entityId === null || cage?.kind !== 'subdivision') {
    if (enterable === undefined) return null;
    return (
      <div className="feature-start" role="toolbar" aria-label="Cage editing">
        <button type="button" className="feature-start__chip" title="Tab" onClick={() => useDirectEditStore.getState().enter(enterable)}>
          Edit cage
        </button>
      </div>
    );
  }
  const edit = useDirectEditStore.getState();
  const refused = preview !== null && !preview.ok;
  const status = refused ? preview.summary : (sharpnessText(cage, selection) ?? selectionText(selection));
  return (
    <div className="cage-bar" role="toolbar" aria-label="Cage editing">
      <div className="cage-bar__row">
        <div className="cage-bar__group" role="group" aria-label="Element">
          {MODES.map(({ kind, label, key }) => (
            <button
              key={kind}
              type="button"
              className="cage-bar__button"
              aria-pressed={elementMode === kind}
              title={`${label} (${key})`}
              onClick={() => edit.setElementMode(kind)}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="cage-bar__group" role="group" aria-label="Tools">
          <button
            type="button"
            className="cage-bar__button"
            aria-pressed={tool === 'loop_cut'}
            title="Loop cut (Ctrl R)"
            onClick={() => edit.setTool(tool === 'loop_cut' ? 'select' : 'loop_cut')}
          >
            Loop cut
          </button>
        </div>
        <FalloffControls />
        <CopyCliButton />
        <button type="button" className="cage-bar__button" onClick={edit.exit} title="Leave cage editing (Tab)">
          Done
        </button>
      </div>
      <div className={refused ? 'cage-bar__status cage-bar__status--error' : 'cage-bar__status'} role="status">
        <span>{status}</span>
        <span className="cage-bar__hint">{hintFor(tool, selection, cuts)}</span>
      </div>
    </div>
  );
}
