import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { useStore } from '@ui/store';
import { LayersPanel } from '@ui/panels/LayersPanel';
import { deleteSelection, duplicateSelection, moveSelection } from '@ui/actions/selectionActions';
import { pickContext } from '@ui/viewport/2d/pickContext';
import { localDispatch, resetOfflineStore } from '../helpers/storeTestHelpers';

function boxOnLockedLayer(): string {
  localDispatch('add_box', { size: [1, 1, 1] });
  const boxId = useStore.getState().document.order[0]!;
  const layerId = localDispatch('add_layer', { name: 'Frozen' }).affected[0]!;
  localDispatch('set_entity_layer', { entityId: boxId, layerId });
  localDispatch('update_layer', { id: layerId, locked: true });
  useStore.getState().select([boxId]);
  return boxId;
}

describe('locked layers', () => {
  beforeEach(() => {
    resetOfflineStore();
  });

  it('the lock toggle in the Layers panel dispatches update_layer', () => {
    const layerId = localDispatch('add_layer', { name: 'Walls' }).affected[0]!;
    render(<LayersPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Lock layer Walls' }));
    expect(useStore.getState().document.layers[layerId]?.locked).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Unlock layer Walls' }));
    expect(useStore.getState().document.layers[layerId]?.locked).toBe(false);
  });

  it('2D picking skips entities on a locked layer', () => {
    const boxId = boxOnLockedLayer();
    const entity = useStore.getState().document.entities[boxId]!;
    expect(pickContext(1).accepts(entity)).toBe(false);
  });

  it('delete, move and duplicate leave a stale selection on a locked layer untouched', () => {
    const boxId = boxOnLockedLayer();
    const before = useStore.getState().document.entities;
    deleteSelection();
    moveSelection([5, 0, 0]);
    duplicateSelection();
    const after = useStore.getState().document.entities;
    expect(Object.keys(after)).toEqual([boxId]);
    expect(after[boxId]).toEqual(before[boxId]);
  });

  it('unlocking the layer restores editing', () => {
    const boxId = boxOnLockedLayer();
    const layerId = useStore.getState().document.entities[boxId]!.layerId;
    localDispatch('update_layer', { id: layerId, locked: false });
    deleteSelection();
    expect(useStore.getState().document.entities[boxId]).toBeUndefined();
  });
});
