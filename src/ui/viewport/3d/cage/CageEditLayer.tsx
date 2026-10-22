// In-Canvas layer of direct cage editing (04 DIR M1/M3), mounted inside the floating-origin group (positions are world space).
// Draws the cage overlays, the drag-preview ghost and the gizmo for the entity in edit mode; input comes from the pointer / key hooks.
// Leaves edit mode when the entity disappears, is deselected or its layer is locked.

import { useEffect } from 'react';
import type { SubdivisionEntity } from '@core/model/types';
import { useStore } from '@ui/store';
import { useDirectEditStore } from '@ui/store/directEditStore';
import { CageGhost } from './CageGhost';
import { CageGizmo } from './CageGizmo';
import { CageOverlay } from './CageOverlay';
import { isSelectionEmpty, pruneSelection } from './cageSelection';
import { useCageKeys } from './useCageKeys';
import { useCagePointer } from './useCagePointer';
import { useCagePreview } from './useCagePreview';

/** The subdivision entity in edit mode, or undefined (mode off, entity gone). */
function useEditedCage(): SubdivisionEntity | undefined {
  const entityId = useDirectEditStore((s) => s.entityId);
  return useStore((s) => {
    const entity = entityId === null ? undefined : s.document.entities[entityId];
    return entity?.kind === 'subdivision' ? entity : undefined;
  });
}

export function CageEditLayer({ onDraggingChanged }: { onDraggingChanged: (dragging: boolean) => void }): React.ReactElement | null {
  const entityId = useDirectEditStore((s) => s.entityId);
  const cage = useEditedCage();
  const selected = useStore((s) => entityId !== null && s.document.selection.includes(entityId));
  const locked = useStore((s) => cage !== undefined && s.document.layers[cage.layerId]?.locked === true);
  const selection = useDirectEditStore((s) => s.selection);
  const hover = useDirectEditStore((s) => s.hover);
  const tool = useDirectEditStore((s) => s.tool);
  const cuts = useDirectEditStore((s) => s.cuts);
  const preview = useDirectEditStore((s) => s.preview);
  const exit = useDirectEditStore((s) => s.exit);
  const setSelection = useDirectEditStore((s) => s.setSelection);
  const active = entityId !== null && cage !== undefined;

  useCagePointer(cage);
  useCageKeys(active);
  useCagePreview();

  useEffect(() => {
    if (entityId !== null && (cage === undefined || !selected || locked)) exit();
  }, [entityId, cage, selected, locked, exit]);

  useEffect(() => {
    if (cage === undefined) return;
    const pruned = pruneSelection(selection, cage);
    if (pruned !== selection) setSelection(pruned);
  }, [cage, selection, setSelection]);

  if (!active || locked) return null;
  const shown = preview?.ok === true && preview.entity !== null ? preview.entity : cage;
  return (
    <>
      <group name="cage-edit" position={cage.position} rotation={[cage.rotation[0], cage.rotation[1], cage.rotation[2]]}>
        <CageOverlay cage={shown} selection={selection} hover={hover} loopCuts={tool === 'loop_cut' ? cuts : null} />
        {preview !== null && <CageGhost preview={preview} />}
      </group>
      {!isSelectionEmpty(selection) && tool === 'select' && (
        <CageGizmo cage={cage} selection={selection} onDraggingChanged={onDraggingChanged} />
      )}
    </>
  );
}
